import { useRouter } from "next/router";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import CopyButton from "~/components/copyButton";
import NearbyCode from "~/components/nearbyCode";
import QrScanner from "~/components/qrScanner";
import Button, { ButtonSize } from "~/components/ui/button";
import Txt, { TxtSize } from "~/components/ui/txt";
import { useKeepAwake } from "~/hooks/keepAwake";
import { resolveInviteOrigins } from "~/lib/nearbyOrigin";
import { answerFailureKey, pickInviteOrigin, replyOrigin } from "~/lib/nearbyPlay";
import {
  deliverReplyToOtherTab,
  getNearby,
  isNearbyError,
  NearbyError,
  NearbyReply,
  parseNearbyText,
} from "~/lib/network";
import { gameUrl } from "~/lib/routes";

/**
 * The guest's side of nearby play (docs/P2P_DESIGN.md, "Handshake (two QR codes)"): scan an
 * invitation, show the reply for the inviter to scan, and open the game once linked. Also what a
 * page does with a reply it was given by mistake: hand it to the inviting tab.
 */

/** How long the inviting tab gets to acknowledge a reply (it may be a throttled background tab). */
const HANDOFF_TIMEOUT_MS = 3000;

export type HandoffOutcome = "applied" | "delivered" | "nobody";

/**
 * A reply reached this tab (its camera app opened the reply URL here, or it was scanned on the
 * wrong screen): apply it if this tab holds the invitation, else hand it to the tab of this
 * browser that does.
 */
export async function handOffReply(text: string): Promise<HandoffOutcome> {
  const nearby = getNearby();
  if (nearby) {
    try {
      await nearby.acceptReply(text);
      return "applied";
    } catch {
      // Not an invitation of this tab.
    }
  }

  return (await deliverReplyToOtherTab(text, HANDOFF_TIMEOUT_MS)) ? "delivered" : "nobody";
}

interface JoinProps {
  /** An invitation to answer at once (the page was opened with it), as a URL or code. */
  initialInvite?: string | null;
}

/**
 * Scan an invitation, then answer it in place (NearbyAnswer). Used by the nearby page and by the
 * join page in nearby mode.
 */
export default function NearbyJoin(props: JoinProps) {
  const { initialInvite = null } = props;
  const { t } = useTranslation();
  const [invite, setInvite] = useState<{ text: string; id: number } | null>(
    initialInvite ? { text: initialInvite, id: 0 } : null
  );
  const [notice, setNotice] = useState<string>(null);
  const countRef = useRef(0);

  const onResult = useCallback(async (text: string): Promise<boolean> => {
    const parsed = parseNearbyText(text);
    if (!parsed) {
      setNotice("nearby.join.notNearby");
      return false;
    }

    if (parsed.kind === "reply") {
      const outcome = await handOffReply(text);
      setNotice(outcome === "nobody" ? "nearby.join.reply" : "nearby.join.replyHandedOff");
      return false;
    }

    setNotice(null);
    countRef.current += 1;
    setInvite({ text, id: countRef.current });
    return true;
  }, []);

  const onScanAnother = useCallback(() => setInvite(null), []);

  if (invite) {
    return <NearbyAnswer key={invite.id} text={invite.text} onScanAnother={onScanAnother} />;
  }

  return (
    <div className="flex flex-column items-center w-100">
      {/* The camera waits for a tap: the page may be open for other reasons than scanning. */}
      <QrScanner autoStart={false} hint={t("nearby.join.scanHint")} onResult={onResult} />
      {notice && <Txt className="light-red tc mt2" role="alert" size={TxtSize.SMALL} value={t(notice)} />}
    </div>
  );
}

type AnswerPhase =
  | { name: "preparing" }
  | { name: "showing"; url: string }
  | { name: "connected" }
  /** `key`: the message (a translation key). */
  | { name: "failed"; key: string };

interface AnswerProps {
  /** The invitation, as scanned or pasted (a URL or a bare code). */
  text: string;
  /** Back to scanning (after a failure, or when the player cancels). */
  onScanAnother: () => void;
}

/**
 * Answer an invitation: show the reply QR code until the inviter scanned it and the devices are
 * linked, then open the game the invitation is for (client-side: a page load would close the link).
 */
export function NearbyAnswer(props: AnswerProps) {
  const { text, onScanAnother } = props;
  const { t } = useTranslation();
  const router = useRouter();
  const [phase, setPhase] = useState<AnswerPhase>({ name: "preparing" });
  const replyRef = useRef<NearbyReply>(null);

  // Read when needed, so that neither restarts the answer.
  const routerRef = useRef(router);
  routerRef.current = router;
  const onScanAnotherRef = useRef(onScanAnother);
  onScanAnotherRef.current = onScanAnother;

  useKeepAwake(phase.name === "showing");

  useEffect(() => {
    let active = true;

    (async () => {
      const nearby = getNearby();
      if (!nearby) {
        throw new NearbyError("no-webrtc");
      }

      // The reply goes back to the inviting device: on the invitation's origin when it had one.
      const origins = await resolveInviteOrigins();
      const reply = await nearby.answerInvite(text, { origin: replyOrigin(text, pickInviteOrigin(origins).origin) });
      if (!active) {
        reply.cancel();
        return;
      }

      replyRef.current = reply;
      setPhase({ name: "showing", url: reply.url });

      const { gameId } = await reply.connected;
      if (!active) return;

      setPhase({ name: "connected" });
      await routerRef.current.replace(gameId ? gameUrl(gameId) : "/");
    })().catch((error) => {
      if (!active) return;

      const reason = isNearbyError(error) ? error.reason : "failed";
      if (!isNearbyError(error)) {
        console.warn("[nearby] could not answer the invitation", error);
      }
      if (reason === "cancelled") {
        onScanAnotherRef.current();
      } else {
        setPhase({ name: "failed", key: answerFailureKey(reason) });
      }
    });

    return () => {
      active = false;
      // No-op once connected.
      replyRef.current?.cancel();
    };
  }, [text]);

  return (
    <div className="flex flex-column items-center w-100">
      {phase.name === "preparing" && (
        <Txt aria-live="polite" className="lavender tc" role="status" value={t("nearby.answer.preparing")} />
      )}

      {phase.name === "showing" && (
        <>
          <Txt className="mb2 tc" size={TxtSize.MEDIUM} value={t("nearby.answer.show")} />
          <NearbyCode label={t("nearby.answer.qrLabel")} url={phase.url} />
          <Txt className="lavender tc mt3" size={TxtSize.SMALL} value={t("nearby.answer.hint")} />
          <Txt aria-live="polite" className="gray tc mt2" role="status" value={t("nearby.answer.waiting")} />
          <Button
            outlined
            className="mt3"
            size={ButtonSize.SMALL}
            text={t("nearby.answer.cancel")}
            onClick={() => replyRef.current?.cancel()}
          />
        </>
      )}

      {phase.name === "connected" && (
        <Txt className="txt-green tc" role="status" value={`✓ ${t("nearby.answer.connected")}`} />
      )}

      {phase.name === "failed" && (
        <>
          <Txt className="light-red tc mb3" role="alert" value={t(phase.key)} />
          <Button primary size={ButtonSize.SMALL} text={t("nearby.answer.scanAnother")} onClick={onScanAnother} />
        </>
      )}
    </div>
  );
}

interface HandoffProps {
  /** The reply, as opened (a URL). */
  text: string;
  /** Leave this page's reply for the landing page (to scan an invitation instead). */
  onDismiss: () => void;
}

/**
 * A reply opened in its own tab: the inviter's camera app opens the reply URL in a new tab of the
 * browser, which hands it to the inviting tab and says so. A reply the inviting tab can't get
 * (another browser, a closed tab) can still be copied and pasted on the invitation screen.
 */
export function NearbyReplyHandoff(props: HandoffProps) {
  const { text, onDismiss } = props;
  const { t } = useTranslation();
  const [outcome, setOutcome] = useState<HandoffOutcome | null>(null);

  useEffect(() => {
    let active = true;
    handOffReply(text).then((result) => {
      if (!active) return;
      setOutcome(result);
      if (result === "delivered") {
        // Only allowed for some tabs (opened by a script or, on some phones, by another app).
        try {
          window.close();
        } catch {
          // Stays open: the message says it can be closed.
        }
      }
    }, console.warn);

    return () => {
      active = false;
    };
  }, [text]);

  if (!outcome) {
    return <Txt aria-live="polite" className="lavender tc" role="status" value={t("nearby.reply.delivering")} />;
  }

  if (outcome !== "nobody") {
    return (
      <Txt
        className="txt-green tc"
        role="status"
        value={`✓ ${t(outcome === "applied" ? "nearby.reply.applied" : "nearby.reply.delivered")}`}
      />
    );
  }

  return (
    <div className="flex flex-column items-center">
      <Txt className="tc mb2" value={t("nearby.reply.notDelivered")} />
      <Txt className="lavender tc mb3" size={TxtSize.SMALL} value={t("nearby.reply.how")} />
      <CopyButton label={t("nearby.reply.copy")} text={text} />
      <Button className="mt4" size={ButtonSize.SMALL} text={t("nearby.scanInvitation")} onClick={onDismiss} />
    </div>
  );
}
