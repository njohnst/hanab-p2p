import classnames from "classnames";
import React, { ChangeEvent, FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import Button, { ButtonSize } from "~/components/ui/button";
import { TextInput } from "~/components/ui/forms";
import Txt, { TxtSize } from "~/components/ui/txt";
import {
  CameraProblem,
  cameraProblemOf,
  cameraSupport,
  centerSquare,
  createScanCanvas,
  decodeQrFromImage,
  getQrDecoder,
} from "~/lib/qr";

/** How often a camera frame is decoded (a few times per second is plenty, and spares phone batteries). */
const SCAN_INTERVAL_MS = 250;

/** Largest side of the analysed picture: the centred square of the frame, scaled down to this. */
const SCAN_SIZE = 640;

/** The back camera on phones; `ideal` never fails, so laptops get their only camera. */
const CAMERA_CONSTRAINTS: MediaStreamConstraints = {
  audio: false,
  video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } },
};

const PROBLEM_MESSAGES: Record<CameraProblem, string> = {
  "insecure": "nearby.scanner.insecure",
  "unsupported": "nearby.scanner.unsupported",
  "denied": "nearby.scanner.denied",
  "no-camera": "nearby.scanner.noCamera",
  "busy": "nearby.scanner.busy",
  "error": "nearby.scanner.error",
};

/** Problems that trying again may solve (after changing a setting or closing another app). */
const RETRYABLE: CameraProblem[] = ["denied", "busy", "error"];

type CameraState =
  | { name: "off" }
  | { name: "starting" }
  | { name: "live" }
  | { name: "problem"; problem: CameraProblem };

type PhotoState = "idle" | "reading" | "not-found";

function pageHidden(): boolean {
  return document.visibilityState === "hidden";
}

interface Props {
  /** What to scan, shown above the camera (e.g. "Then scan the code on their screen"). */
  hint: string;
  /**
   * Called with each new code read by the camera, found in a photo, or pasted. Return (or resolve
   * to) true when it was the expected code: the scanner then stops. false keeps scanning (the
   * wrong kind of code: the caller tells the player why).
   */
  onResult: (text: string) => boolean | Promise<boolean>;
  /** Start the camera at once (default), or wait for the player to ask for it. */
  autoStart?: boolean;
  /** The camera shows a picture: its permission is granted. */
  onCameraReady?: () => void;
  /** The camera can't be used. Photos and pasting remain. */
  onCameraUnavailable?: (problem: CameraProblem) => void;
  className?: string;
}

/**
 * Reads a QR code: with the live camera where the page may use it (secure pages), decoding a few
 * frames per second with the browser's BarcodeDetector or jsQR (~/lib/qr). Two fallbacks are
 * always offered: taking a photo (the phone's camera, through a file input: works on http pages
 * too) and pasting the code or link as text.
 *
 * The camera is stopped when the scanner unmounts and while the page is hidden, and restarted when
 * the page is visible again. A code the camera keeps seeing is only reported once.
 */
export default function QrScanner(props: Props) {
  const { hint, onResult, autoStart = true, onCameraReady, onCameraUnavailable, className } = props;
  const { t } = useTranslation();

  const [wanted, setWanted] = useState(autoStart);
  const [attempt, setAttempt] = useState(0);
  const [camera, setCamera] = useState<CameraState>({ name: "off" });
  const [done, setDone] = useState(false);
  const [photo, setPhoto] = useState<PhotoState>("idle");
  const [pasted, setPasted] = useState("");

  const videoRef = useRef<HTMLVideoElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const busyRef = useRef(false);
  const lastScannedRef = useRef<string>(null);
  const mountedRef = useRef(true);

  // The latest callbacks, so the camera does not restart whenever the parent renders.
  const callbacksRef = useRef({ onResult, onCameraReady, onCameraUnavailable });
  callbacksRef.current = { onResult, onCameraReady, onCameraUnavailable };

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  /** Hand a code to the caller; resolves whether it was accepted. */
  const deliver = useCallback(async (text: string): Promise<boolean> => {
    busyRef.current = true;
    try {
      const accepted = await callbacksRef.current.onResult(text);
      if (accepted && mountedRef.current) {
        setDone(true);
      }
      return accepted;
    } catch (e) {
      console.warn("[scanner] the scanned code could not be handled", e);
      return false;
    } finally {
      busyRef.current = false;
    }
  }, []);

  /** Report a camera that can't be used, when not wanted yet too (so a page tells right away). */
  useEffect(() => {
    const problem = cameraSupport({
      secure: window.isSecureContext,
      getUserMedia: typeof navigator.mediaDevices?.getUserMedia === "function",
    });
    if (problem) {
      setCamera({ name: "problem", problem });
      callbacksRef.current.onCameraUnavailable?.(problem);
    }
  }, []);

  /** The camera and the decoding loop. */
  useEffect(() => {
    if (!wanted || done) {
      return;
    }
    if (
      cameraSupport({
        secure: window.isSecureContext,
        getUserMedia: typeof navigator.mediaDevices?.getUserMedia === "function",
      })
    ) {
      return;
    }

    let active = true;
    let starting = false;
    let stream: MediaStream | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    /** Each camera start gets its own decoding loop; a loop of a stopped camera ends. */
    let loop = 0;

    const stop = () => {
      loop += 1;
      if (timer) clearTimeout(timer);
      timer = null;
      stream?.getTracks().forEach((track) => track.stop());
      stream = null;
      if (videoRef.current) {
        videoRef.current.srcObject = null;
      }
    };

    const scanFrame = async () => {
      const video = videoRef.current;
      if (!video || busyRef.current || video.readyState < 2 || !video.videoWidth || !video.videoHeight) {
        return;
      }

      const decoder = await getQrDecoder();
      const { x, y, size } = centerSquare(video.videoWidth, video.videoHeight);
      const target = Math.min(size, SCAN_SIZE);
      const canvas = canvasRef.current || (canvasRef.current = createScanCanvas());
      if (canvas.width !== target || canvas.height !== target) {
        canvas.width = target;
        canvas.height = target;
      }
      canvas.getContext("2d").drawImage(video, x, y, size, size, 0, 0, target, target);

      const text = await decoder.decode(canvas);
      if (text && active && text !== lastScannedRef.current) {
        lastScannedRef.current = text;
        await deliver(text);
      }
    };

    const scanLater = (current: number) => {
      timer = setTimeout(async () => {
        timer = null;
        try {
          await scanFrame();
        } catch (e) {
          console.warn("[scanner] could not decode a frame", e);
        }
        if (active && stream && current === loop) {
          scanLater(current);
        }
      }, SCAN_INTERVAL_MS);
    };

    const start = async () => {
      if (!active || stream || starting || pageHidden()) {
        return;
      }

      starting = true;
      setCamera({ name: "starting" });
      try {
        const media = await navigator.mediaDevices.getUserMedia(CAMERA_CONSTRAINTS);
        // The page may have been hidden (camera stopped) while the permission prompt was open.
        if (!active || pageHidden() || !videoRef.current) {
          media.getTracks().forEach((track) => track.stop());
          return;
        }

        stream = media;
        const video = videoRef.current;
        video.muted = true;
        video.srcObject = media;
        // autoPlay covers browsers that refuse play() here; the frames are read either way.
        await video.play().catch(() => undefined);
        if (!active || stream !== media) {
          return;
        }

        setCamera({ name: "live" });
        callbacksRef.current.onCameraReady?.();
        loop += 1;
        scanLater(loop);
      } catch (e) {
        if (!active) return;
        console.warn("[scanner] no camera", e);
        const problem = cameraProblemOf(e);
        setCamera({ name: "problem", problem });
        callbacksRef.current.onCameraUnavailable?.(problem);
      } finally {
        starting = false;
      }
    };

    const onVisibilityChange = () => {
      if (pageHidden()) {
        stop();
      } else {
        start();
      }
    };

    start();
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      active = false;
      document.removeEventListener("visibilitychange", onVisibilityChange);
      stop();
    };
  }, [wanted, done, attempt, deliver]);

  async function onPhoto(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    // Cleared so that choosing the same photo again fires another change.
    e.target.value = "";
    if (!file) return;

    setPhoto("reading");
    let text: string | null = null;
    try {
      text = await decodeQrFromImage(file);
    } catch (error) {
      console.warn("[scanner] could not read the photo", error);
    }
    if (!mountedRef.current) return;

    setPhoto(text ? "idle" : "not-found");
    if (text) {
      await deliver(text);
    }
  }

  async function onPaste(e: FormEvent) {
    e.preventDefault();
    const text = pasted.trim();
    if (!text) return;

    if ((await deliver(text)) && mountedRef.current) {
      setPasted("");
    }
  }

  function onRetry() {
    lastScannedRef.current = null;
    setCamera({ name: "off" });
    setWanted(true);
    setAttempt((count) => count + 1);
  }

  if (done) {
    return (
      <div className={classnames("flex flex-column items-center", className)}>
        <Txt className="txt-green" role="status" value={`✓ ${t("nearby.scanner.read")}`} />
      </div>
    );
  }

  const problem = camera.name === "problem" ? camera.problem : null;
  const showVideo = wanted && !problem;

  return (
    <div aria-label={hint} className={classnames("flex flex-column items-center w-100", className)} role="group">
      <Txt className="mb2 tc" value={hint} />

      {showVideo && (
        <div className="qr-scanner br3 mb2">
          <video ref={videoRef} autoPlay muted playsInline aria-label={t("nearby.scanner.preview")} />
          <span aria-hidden className="qr-scanner-frame" />
          {camera.name !== "live" && (
            <span className="qr-scanner-status flex items-center justify-center tc pa2">
              <Txt size={TxtSize.SMALL} value={t("nearby.scanner.starting")} />
            </span>
          )}
        </div>
      )}

      {!wanted && !problem && (
        <Button
          primary
          className="mb2"
          id="start-camera"
          size={ButtonSize.MEDIUM}
          text={t("nearby.scanner.start")}
          onClick={() => setWanted(true)}
        />
      )}

      {problem && (
        <div className="flex flex-column items-center mb2" role="status">
          <Txt className="lavender tc" size={TxtSize.SMALL} value={t(PROBLEM_MESSAGES[problem])} />
          {RETRYABLE.includes(problem) && (
            <Button className="mt2" size={ButtonSize.SMALL} text={t("nearby.scanner.retry")} onClick={onRetry} />
          )}
        </div>
      )}

      <Button
        outlined
        disabled={photo === "reading"}
        size={ButtonSize.SMALL}
        text={photo === "reading" ? t("nearby.scanner.readingPhoto") : t("nearby.scanner.takePhoto")}
        onClick={() => fileRef.current?.click()}
      />
      <input
        ref={fileRef}
        aria-hidden
        accept="image/*"
        capture="environment"
        className="absolute o-0"
        style={{ width: 1, height: 1, pointerEvents: "none" }}
        tabIndex={-1}
        type="file"
        onChange={onPhoto}
      />
      {photo === "not-found" && (
        <Txt className="light-red tc mt2" role="alert" size={TxtSize.SMALL} value={t("nearby.scanner.noCodeInPhoto")} />
      )}

      <form noValidate className="flex flex-column w-100 mt3" onSubmit={onPaste}>
        <Txt className="lavender tc mb1" size={TxtSize.SMALL} value={t("nearby.scanner.pasteLabel")} />
        <div className="flex">
          <TextInput
            aria-label={t("nearby.scanner.pasteLabel")}
            autoCapitalize="off"
            autoComplete="off"
            autoCorrect="off"
            className="flex-auto h-auto f6 mr2 w-100"
            enterKeyHint="go"
            placeholder={t("nearby.scanner.pastePlaceholder")}
            spellCheck={false}
            style={{ minWidth: 0 }}
            value={pasted}
            onChange={(e) => setPasted(e.target.value)}
          />
          <Button disabled={!pasted.trim()} size={ButtonSize.SMALL} text={t("nearby.scanner.use")} type="submit" />
        </div>
      </form>
    </div>
  );
}
