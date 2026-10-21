import { useRouter } from "next/router";
import React, { useContext, useState } from "react";
import { useTranslation } from "react-i18next";
import LanguageSelector from "~/components/languageSelector";
import Rules from "~/components/rules";
import ShareGame from "~/components/shareGame";
import { TutorialContext } from "~/components/tutorial";
import Button, { ButtonSize } from "~/components/ui/button";
import { Modal } from "~/components/ui/modal";
import Txt, { TxtSize } from "~/components/ui/txt";
import UserPreferencesDialog from "~/components/userPreferencesDialog";
import { useGame } from "~/hooks/game";
import { useNetworkMode } from "~/hooks/networkMode";
import { UserPreferences, useUserPreferences } from "~/hooks/userPreferences";
import { logFailedPromise } from "~/lib/errors";
import { GameMode } from "~/lib/state";

interface Props {
  onCloseArea: () => void;
  /** Nearby mode: open the invitation dialog, owned by the game so that it outlives this menu. */
  onInviteNearby?: () => void;
}

export default function MenuArea(props: Props) {
  const { onCloseArea, onInviteNearby } = props;
  const nearby = useNetworkMode() === "nearby";

  const [showRules, setShowRules] = useState(false);
  const [showInvite, setShowInvite] = useState(false);
  const game = useGame();
  const canInvite = game?.options.gameMode === GameMode.NETWORK && !game.options.tutorial;
  const { reset } = useContext(TutorialContext);
  const router = useRouter();
  const { t } = useTranslation();
  const [showUserPreferences, setShowUserPreferences] = useState(false);
  const [userPreferences, setUserPreferences] = useUserPreferences();

  function onPrefClick() {
    setShowUserPreferences(true);
  }
  function onMenuClick() {
    router.push("/").catch(logFailedPromise);
  }

  function onTutorialClick() {
    reset();
    onCloseArea();
  }

  if (showUserPreferences) {
    return (
      <UserPreferencesDialog
        saveUserPreferences={(userPreferences: UserPreferences) => {
          setUserPreferences(userPreferences);
        }}
        userPreferences={userPreferences}
        onCloseArea={() => {
          setShowUserPreferences(false);
        }}
      />
    );
  }

  return (
    <Modal isOpen onRequestClose={() => onCloseArea()}>
      <div className={`flex flex-column justify-center items-center w-100 h-100 z-10 ${showRules ? "" : "pa2"}`}>
        {!showRules && !showInvite && (
          <div className="flex flex-column justify-center items-center">
            <Txt className="ttu txt-yellow mb4 mb5-l" size={TxtSize.MEDIUM} value={t("hanab")} />

            <div className="mb4 mb5-l">
              <LanguageSelector />
            </div>
            {canInvite && (
              <Button
                primary
                className="mb3 w-100"
                size={ButtonSize.MEDIUM}
                text={t("invitePlayers")}
                onClick={() => (nearby && onInviteNearby ? onInviteNearby() : setShowInvite(true))}
              />
            )}
            <Button className="mb3 w-100" size={ButtonSize.MEDIUM} text={t("userPreferences")} onClick={onPrefClick} />
            <Button className="mb3 w-100" size={ButtonSize.MEDIUM} text={t("menu")} onClick={onMenuClick} />
            <Button className="mb3 w-100" size={ButtonSize.MEDIUM} text={t("tutorial")} onClick={onTutorialClick} />
            <Button
              className="mb3 w-100"
              size={ButtonSize.MEDIUM}
              text={t("rules")}
              onClick={() => setShowRules(true)}
            />
          </div>
        )}

        {showInvite && (
          <div className="flex flex-column items-center pv3">
            <ShareGame inviteNow gameId={game.id} />
            <Button className="mt4" size={ButtonSize.SMALL} text={t("back")} onClick={() => setShowInvite(false)} />
          </div>
        )}

        {showRules && (
          <div className="overflow-y-scroll">
            <Rules setShowRules={setShowRules} />
          </div>
        )}
      </div>
    </Modal>
  );
}
