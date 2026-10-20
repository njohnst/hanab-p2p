/**
 * QR codes: drawing them (the online share link, nearby invitations and replies) and reading them
 * back with the camera or from a photo (~/components/qrScanner, for nearby play: see
 * docs/P2P_DESIGN.md, "Handshake (two QR codes)").
 *
 * Both libraries are loaded on demand: "qrcode" where a code is shown, and "jsqr" only when the
 * browser has no native BarcodeDetector that reads QR codes (Safari, Firefox and desktop Chrome on
 * Windows or Linux don't).
 *
 * The geometry and error helpers are pure, so they are unit-tested in Node (qr.test.ts).
 */

/** Options for renderQrSvg. */
export interface QrSvgOptions {
  /**
   * Quiet zone around the code, in modules. 4 is the standard, which camera apps want when the code
   * is shown on its own; 1 saves room when the code sits in white padding anyway (the share panel).
   */
  margin?: number;
}

/** The SVG markup of a QR code (error correction M) of `text`, dark on white. */
export async function renderQrSvg(text: string, options: QrSvgOptions = {}): Promise<string> {
  // Loaded on demand: only lobbies and the invite dialogs need it.
  const mod = await import("qrcode");
  const QRCode = ((mod as unknown) as { default?: typeof mod }).default ?? mod;

  return QRCode.toString(text, { type: "svg", margin: options.margin ?? 1, errorCorrectionLevel: "M" });
}

/* ------------------------------------------------------------------ */
/* Geometry                                                            */
/* ------------------------------------------------------------------ */

/** The largest size fitting in `max` x `max` with the aspect ratio of width x height, never larger than it. */
export function fitWithin(width: number, height: number, max: number): { width: number; height: number } {
  if (width <= 0 || height <= 0) {
    return { width: 0, height: 0 };
  }

  const scale = Math.min(1, max / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/** The centred square of a width x height frame: what a square preview with `object-fit: cover` shows. */
export function centerSquare(width: number, height: number): { x: number; y: number; size: number } {
  const size = Math.max(0, Math.min(width, height));
  return { x: Math.floor((width - size) / 2), y: Math.floor((height - size) / 2), size };
}

/* ------------------------------------------------------------------ */
/* Camera                                                              */
/* ------------------------------------------------------------------ */

/**
 * Why the camera cannot be used:
 *
 * insecure    - the page is not a secure context (http on a LAN address): browsers only give the
 *               camera to https and localhost pages.
 * unsupported - no getUserMedia (an old or embedded browser).
 * denied      - the player or the browser's settings refused the permission.
 * no-camera   - the device has no (suitable) camera.
 * busy        - another app or tab holds the camera.
 * error       - anything else.
 */
export type CameraProblem = "insecure" | "unsupported" | "denied" | "no-camera" | "busy" | "error";

/** Whether the camera can be asked for at all, before trying: null when it can. */
export function cameraSupport(environment: { secure: boolean; getUserMedia: boolean }): CameraProblem | null {
  if (!environment.secure) {
    return "insecure";
  }

  return environment.getUserMedia ? null : "unsupported";
}

/** The problem behind a getUserMedia rejection (a DOMException, by name; older browsers used other names). */
export function cameraProblemOf(error: unknown): CameraProblem {
  const name = error && typeof error === "object" && "name" in error ? String((error as { name: unknown }).name) : "";

  switch (name) {
    case "NotAllowedError":
    case "PermissionDeniedError":
    case "SecurityError":
      return "denied";
    case "NotFoundError":
    case "DevicesNotFoundError":
    case "OverconstrainedError":
    case "ConstraintNotSatisfiedError":
      return "no-camera";
    case "NotReadableError":
    case "TrackStartError":
    case "AbortError":
      return "busy";
    default:
      return "error";
  }
}

/* ------------------------------------------------------------------ */
/* Decoding                                                            */
/* ------------------------------------------------------------------ */

/** Reads the QR code drawn on a canvas, if any. */
export interface QrDecoder {
  decode(canvas: HTMLCanvasElement): Promise<string | null>;
}

/** The parts of the Barcode Detection API used (not in TypeScript's DOM types yet). */
interface BarcodeDetectorLike {
  detect(source: CanvasImageSource): Promise<Array<{ rawValue?: string }>>;
}

interface BarcodeDetectorClass {
  new (options: { formats: string[] }): BarcodeDetectorLike;
  getSupportedFormats(): Promise<string[]>;
}

type JsQr = typeof import("jsqr").default;

let jsQrPromise: Promise<JsQr> | null = null;

function loadJsQr(): Promise<JsQr> {
  if (!jsQrPromise) {
    jsQrPromise = import("jsqr").then((mod) => {
      const exported = mod as unknown;
      return (typeof exported === "function" ? exported : (exported as { default: JsQr }).default) as JsQr;
    });
    // A failed download (offline before the chunk was cached) may succeed later.
    jsQrPromise.catch(() => {
      jsQrPromise = null;
    });
  }

  return jsQrPromise;
}

async function decodeWithJsQr(canvas: HTMLCanvasElement): Promise<string | null> {
  const jsQR = await loadJsQr();
  const context = canvas.getContext("2d");
  if (!context || !canvas.width || !canvas.height) {
    return null;
  }

  const { data, width, height } = context.getImageData(0, 0, canvas.width, canvas.height);
  // Our codes are dark on white, but screenshots in dark mode or odd photos may be inverted.
  return jsQR(data, width, height, { inversionAttempts: "attemptBoth" })?.data || null;
}

async function nativeDetector(): Promise<BarcodeDetectorLike | null> {
  const Detector =
    typeof window === "undefined" ? undefined : (window as { BarcodeDetector?: BarcodeDetectorClass }).BarcodeDetector;
  if (!Detector) {
    return null;
  }

  try {
    const formats = await Detector.getSupportedFormats();
    return formats.includes("qr_code") ? new Detector({ formats: ["qr_code"] }) : null;
  } catch {
    return null;
  }
}

let decoderPromise: Promise<QrDecoder> | null = null;

/**
 * The browser's BarcodeDetector when it reads QR codes, else jsQR. Created once; a detector that
 * fails at detection time (some implementations only throw then) is replaced by jsQR for good.
 */
export function getQrDecoder(): Promise<QrDecoder> {
  if (!decoderPromise) {
    decoderPromise = nativeDetector().then((detector) => {
      let native = detector;

      return {
        async decode(canvas: HTMLCanvasElement) {
          if (native) {
            try {
              const codes = await native.detect(canvas);
              return codes.find((code) => code.rawValue)?.rawValue || null;
            } catch (e) {
              console.warn("[qr] BarcodeDetector failed, using jsQR instead", e);
              native = null;
            }
          }
          return decodeWithJsQr(canvas);
        },
      };
    });
  }

  return decoderPromise;
}

/** A canvas meant to be read back often (the 2D context is created with that hint). */
export function createScanCanvas(): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.getContext("2d", { willReadFrequently: true });
  return canvas;
}

/** Sizes tried on a photo, largest side in pixels: phone photos are huge, and jsQR is slow on them. */
const PHOTO_SIZES = [1024, 1600, 640];

function loadImage(file: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("This file is not an image the browser can read"));
    };
    image.src = url;
  });
}

/**
 * The QR code in a photo (from <input type="file" capture>), or null. The photo is scaled down
 * first, trying a few sizes: what works best depends on how big the code is in the picture.
 */
export async function decodeQrFromImage(file: Blob): Promise<string | null> {
  const image = await loadImage(file);
  const decoder = await getQrDecoder();
  const canvas = createScanCanvas();
  const context = canvas.getContext("2d");
  const tried = new Set<string>();

  for (const max of PHOTO_SIZES) {
    const { width, height } = fitWithin(image.naturalWidth, image.naturalHeight, max);
    const key = `${width}x${height}`;
    if (!width || tried.has(key)) {
      continue;
    }
    tried.add(key);

    canvas.width = width;
    canvas.height = height;
    context.drawImage(image, 0, 0, width, height);
    const text = await decoder.decode(canvas);
    if (text) {
      return text;
    }
  }

  return null;
}
