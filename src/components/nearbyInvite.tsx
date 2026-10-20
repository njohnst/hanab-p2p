import classnames from "classnames";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import NearbyCode from "~/components/nearbyCode";
import QrScanner from "~/components/qrScanner";
import Button, { ButtonSize } from "~/components/ui/button";
import { Select } from "~/components/ui/forms";
import { Modal } from "~/components/ui/modal";
import Txt, { TxtSize } from "~/components/ui/txt";
import { useKeepAwake } from "~/hooks/keepAwake";
import { InviteOrigins, resolveInviteOrigins } from "~/lib/nearbyOrigin";
import { createFailureKey, inviteFailureKey, moveToOrigin, pickInviteOrigin, replyNoticeKey } from "~/lib/nearbyPlay";
import { getNearby, isNearbyError, NearbyErrorReason, NearbyInvite as Invite, parseNearbyText } from "~/lib/network";

interface Props {
  /** The game the guest is invited to (it opens on their screen once linked); null for none. */
  gameId: string | null;
  /** Offered next to "Invite another player" once connected, e.g. to close the dialog. */
  onDone?: () => void;
  className?: string;
}

/**
 * "Invite a nearby player" (docs/P2P_DESIGN.md, "Handshake (two QR codes)"): this device shows an
 * invitation QR code, the guest scans it and shows a reply, this device scans the reply, and the
 * two tabs are linked, with no internet. Starts as soon as it is shown; "Invite another player"
 * and "Make a new invitation" start over with a fresh invitation.
 */
export function NearbyInvite(props: Props) {
  const [session, setSession] = useState(1);

  return <InviteSession key={session} {...props} onRestart={() => setSession((count) => count + 1)} />;
}

/** NearbyInvite in a dialog (the lobby, the connection indicator). */
export function NearbyInviteModal(props: { gameId: string | null; onClose: () => void }) {
  const { gameId, onClose } = props;
  const { t } = useTranslation();

  return (
    <Modal isOpen contentLabel={t("nearby.invite.title")} onRequestClose={onClose}>
      <div className="pt4 pb2">
        <NearbyInvite gameId={gameId} onDone={onClose} />
      </div>
    </Modal>
  );
}

type Phase =
  /** The camera, then the invitation, are being prepared. */
  | { name: "starting" }
  /** The invitation is shown; the camera scans for the reply. */
  | { name: "waiting"; invite: Invite }
  /** A reply was applied: the devices are connecting (at most ~20s). */
  | { name: "connecting"; invite: Invite }
  | { name: "connected" }
  /** `key`: the message (a translation key). */
  | { name: "failed"; key: string };

function reasonOf(error: unknown): NearbyErrorReason {
  if (!isNearbyError(error)) {
    console.warn("[nearby] unexpected error", error);
  }
  return isNearbyError(error) ? error.reason : "failed";
}

function phaseInvite(phase: Phase): Invite | null {
  return phase.name === "waiting" || phase.name === "connecting" ? phase.invite : null;
}

/**
 * One invitation, from the camera to the link. The camera starts FIRST: browsers only reveal the
 * device's real network addresses (instead of mDNS names, which networks blocking multicast can't
 * resolve) to pages using the camera, and those addresses go into the invitation. The camera is
 * then needed anyway, to scan the reply. Without a camera (denied, none, an http page) the
 * invitation is made all the same.
 */
function InviteSession(props: Props & { onRestart: () => void }) {
  const { gameId, onDone, onRestart, className } = props;
  const { t } = useTranslation();

  const [phase, setPhase] = useState<Phase>({ name: "starting" });
  const [cameraSettled, setCameraSettled] = useState(false);
  const [origins, setOrigins] = useState<InviteOrigins>(null);
  const [shownOrigin, setShownOrigin] = useState<string>(null);
  const [notice, setNotice] = useState<string>(null);

  const mountedRef = useRef(true);
  const startedRef = useRef(false);
  /** The invitations made here, with when: those still pending are cancelled when the session ends... */
  const createdRef = useRef(new Map<Invite, number>());
  /** ...except those whose reply was scanned here: the guest is waiting, let them connect. */
  const repliedRef = useRef(new Set<Invite>());

  useKeepAwake(phase.name === "waiting" || phase.name === "connecting");

  useEffect(() => {
    // The collections themselves never change, only their content.
    const created = createdRef.current;
    const replied = repliedRef.current;
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      // cancel() is a no-op for the invitation that connected.
      created.forEach((_, invite) => !replied.has(invite) && invite.cancel());
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    resolveInviteOrigins().then((resolved) => {
      if (cancelled) return;
      setOrigins(resolved);
      setShownOrigin(pickInviteOrigin(resolved).origin);
    });

    return () => {
      cancelled = true;
    };
  }, []);

  /** Follow an invitation (made at `since`) to its end: connected, or failed (unless the session moved on). */
  const follow = useCallback((invite: Invite, since: number) => {
    invite.connected.then(
      () => {
        if (!mountedRef.current) return;
        setPhase((current) => (phaseInvite(current) === invite ? { name: "connected" } : current));
      },
      (error) => {
        const reason = reasonOf(error);
        if (!mountedRef.current || reason === "cancelled") return;
        setPhase((current) =>
          phaseInvite(current) === invite
            ? {
                name: "failed",
                key: inviteFailureKey(reason, { replied: current.name === "connecting", ageMs: Date.now() - since }),
              }
            : current
        );
      }
    );
  }, []);

  const origin = origins ? pickInviteOrigin(origins).origin : null;

  /** Make the invitation once the camera is settled (live, unavailable or skipped). */
  useEffect(() => {
    if (!cameraSettled || origin === null || startedRef.current) {
      return;
    }
    startedRef.current = true;

    const nearby = getNearby();
    if (!nearby) {
      setPhase({ name: "failed", key: "nearby.invite.prepareFailed" });
      return;
    }

    nearby.createInvite({ gameId, origin }).then(
      (invite) => {
        if (!mountedRef.current) {
          invite.cancel();
          return;
        }
        createdRef.current.set(invite, Date.now());
        setPhase({ name: "waiting", invite });
        follow(invite, Date.now());
      },
      (error) => {
        if (mountedRef.current) {
          setPhase({ name: "failed", key: createFailureKey(reasonOf(error)) });
        }
      }
    );
  }, [cameraSettled, origin, gameId, follow]);

  /** A code from the scanner: the guest's reply, hopefully. */
  const onReply = useCallback(
    async (text: string): Promise<boolean> => {
      const parsed = parseNearbyText(text);
      if (!parsed) {
        setNotice("nearby.invite.notice.notNearby");
        return false;
      }
      if (parsed.kind === "invite") {
        setNotice("nearby.invite.notice.invitation");
        return false;
      }

      const nearby = getNearby();
      if (!nearby) {
        return false;
      }

      try {
        // Any pending invitation of this tab, matched by its token: usually this one.
        const invite = await nearby.acceptReply(text);
        if (!mountedRef.current) return true;

        setNotice(null);
        repliedRef.current.add(invite);
        if (!createdRef.current.has(invite)) {
          // Another invitation of this tab (another dialog's, which owns it): follow it here too.
          follow(invite, Date.now());
        }
        setPhase((current) => (current.name === "connected" ? current : { name: "connecting", invite }));
        return true;
      } catch (error) {
        const reason = reasonOf(error);
        const noticeKey = replyNoticeKey(reason);
        if (noticeKey) {
          setNotice(noticeKey);
          return false;
        }
        if (reason !== "cancelled" && mountedRef.current) {
          // "timeout" here is an expired invitation (the reply was never applied).
          setPhase({ name: "failed", key: inviteFailureKey(reason, { replied: false, ageMs: Infinity }) });
        }
        return true;
      }
    },
    [follow]
  );

  const onCameraSettled = useCallback(() => setCameraSettled(true), []);

  const invite = phaseInvite(phase);
  const choice = origins ? pickInviteOrigin(origins) : null;
  const url = invite && origin && shownOrigin ? moveToOrigin(invite.url, origin, shownOrigin) : null;

  return (
    <div className={classnames("flex flex-column items-center w-100", className)}>
      <Txt className="mb3 tc" size={TxtSize.MEDIUM} value={t("nearby.invite.title")} />

      {phase.name === "connected" && (
        <div className="flex flex-column items-center" role="status">
          <Txt className="txt-green tc mb3" value={`✓ ${t("nearby.invite.connected")}`} />
          <div className="flex flex-wrap justify-center">
            <Button
              primary
              className="ma1"
              id="invite-another"
              size={ButtonSize.SMALL}
              text={t("nearby.invite.another")}
              onClick={onRestart}
            />
            {onDone && (
              <Button
                outlined
                className="ma1"
                size={ButtonSize.SMALL}
                text={t("nearby.invite.done")}
                onClick={onDone}
              />
            )}
          </div>
        </div>
      )}

      {phase.name === "failed" && (
        <div className="flex flex-column items-center">
          <Txt className="light-red tc mb3" role="alert" value={t(phase.key)} />
          <Button primary size={ButtonSize.SMALL} text={t("nearby.invite.retry")} onClick={onRestart} />
        </div>
      )}

      {phase.name === "connecting" && (
        <Txt aria-live="polite" className="lavender tc" role="status" value={t("nearby.connecting")} />
      )}

      {(phase.name === "starting" || phase.name === "waiting") && (
        <div className="flex flex-column flex-row-ns items-center items-start-ns justify-center w-100">
          <section className="flex flex-column items-center mb3 mr4-ns">
            <Txt className="mb2 tc" value={t("nearby.invite.step1")} />
            {url ? (
              <NearbyCode label={t("nearby.invite.qrLabel")} url={url} />
            ) : (
              <div className="nearby-qr nearby-qr-placeholder br2 flex items-center justify-center tc pa3">
                <Txt
                  aria-live="polite"
                  size={TxtSize.SMALL}
                  value={cameraSettled ? t("nearby.invite.preparing") : t("nearby.invite.allowCamera")}
                />
              </div>
            )}
            {!cameraSettled && (
              <button
                className="bg-transparent bn pa1 mt1 lavender underline pointer f6"
                type="button"
                onClick={onCameraSettled}
              >
                {t("nearby.invite.skipCamera")}
              </button>
            )}
            {choice && choice.choices.length > 1 && (
              <label className="flex flex-column items-center mt2">
                <Txt className="lavender mb1" size={TxtSize.XSMALL} value={t("nearby.invite.address")} />
                <Select
                  className="ph2"
                  options={choice.choices.reduce((options, value) => ({ ...options, [value]: value }), {})}
                  value={shownOrigin}
                  onChange={(e) => setShownOrigin(e.target.value)}
                />
              </label>
            )}
            {choice?.localOnly && (
              <Txt
                className="db gold tc mt2 mw5"
                role="note"
                size={TxtSize.XSMALL}
                value={t("nearby.invite.localhostWarning")}
              />
            )}
          </section>

          <section className="flex flex-column items-center" style={{ maxWidth: "18rem" }}>
            <QrScanner
              hint={t("nearby.invite.step2")}
              onCameraReady={onCameraSettled}
              onCameraUnavailable={onCameraSettled}
              onResult={onReply}
            />
            {notice && <Txt className="light-red tc mt2" role="alert" size={TxtSize.SMALL} value={t(notice)} />}
          </section>
        </div>
      )}
    </div>
  );
}
