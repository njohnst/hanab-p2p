import React from "react";
import { useTranslation } from "react-i18next";
import Button, { ButtonSize } from "~/components/ui/button";
import { ForfeitAction } from "~/lib/actions";
import { logFailedPromise } from "~/lib/errors";
import { voteForfeit } from "~/lib/network";
import IGameState from "~/lib/state";

interface Props {
  game: IGameState;
  playerId: string;
  confirming: boolean;
  onDismiss: () => void;
}

export default function ForfeitVote({ game, playerId, confirming, onDismiss }: Props) {
  const { t } = useTranslation();
  const request = game.forfeit?.closed ? undefined : game.forfeit;
  const humans = game.players.filter((player) => !player.bot);
  const canVote = humans.some((player) => player.id === playerId);

  function vote(action: ForfeitAction) {
    voteForfeit(game, action).catch(logFailedPromise);
    onDismiss();
  }

  if (!request && (!confirming || !canVote)) return null;

  return (
    <section aria-label={t("forfeit", "Forfeit game")} className="bg-black-50 bb b--yellow pa2 ph6.5-m">
      <div role="status">
        {request ? (
          <>
            <strong>
              {t("forfeitRequestedBy", "{{name}} requested a forfeit.", {
                name: humans.find((player) => player.id === request.requesterId)?.name,
              })}
            </strong>
            <span className="ml2">
              {t("forfeitApprovalProgress", "{{approved}} of {{total}} approved", {
                approved: request.approvedBy.length,
                total: humans.length,
              })}
            </span>
          </>
        ) : (
          <strong>{t("forfeit", "Forfeit game")}</strong>
        )}
        <p className="mt1 mb2">
          {t("forfeitUnanimous", "Every seated human must approve, including disconnected players.")}
        </p>
      </div>
      {canVote && (
        <div className="flex flex-wrap">
          {!request && (
            <>
              <Button
                primary
                className="mr2"
                disabled={!game.synced}
                size={ButtonSize.SMALL}
                text={t("forfeitRequest", "Request forfeit")}
                onClick={() => vote("request")}
              />
              <Button void size={ButtonSize.SMALL} text={t("back")} onClick={onDismiss} />
            </>
          )}
          {request?.requesterId === playerId && (
            <Button
              outlined
              disabled={!game.synced}
              size={ButtonSize.SMALL}
              text={t("forfeitCancel", "Cancel request")}
              onClick={() => vote("cancel")}
            />
          )}
          {request && request.requesterId !== playerId && (
            <>
              <Button
                primary
                className="mr2"
                disabled={!game.synced || request.approvedBy.includes(playerId)}
                size={ButtonSize.SMALL}
                text={
                  request.approvedBy.includes(playerId)
                    ? t("forfeitApproved", "Approved")
                    : t("forfeitApprove", "Approve")
                }
                onClick={() => vote("approve")}
              />
              <Button
                outlined
                disabled={!game.synced}
                size={ButtonSize.SMALL}
                text={t("forfeitReject", "Reject")}
                onClick={() => vote("reject")}
              />
            </>
          )}
        </div>
      )}
    </section>
  );
}
