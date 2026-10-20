import Link from "next/link";
import { useRouter } from "next/router";
import React, { useState } from "react";
import { useTranslation } from "react-i18next";
import Button, { ButtonSize } from "~/components/ui/button";
import Txt, { TxtSize } from "~/components/ui/txt";
import { gameUrl, queryParam } from "~/lib/routes";
import { useTutorialAction } from "~/lib/tutorial";

export default function TutorialInstructions() {
  const [showTutorial, setShowTutorial] = useState(true);
  const router = useRouter();
  const action = useTutorialAction();
  const { t } = useTranslation();
  const originalGameId = queryParam(router.query["back-to-game"]);

  if (!showTutorial) {
    return null;
  }

  if (!action) {
    return (
      <div className="relative flex flex-column bg-black-50 bt b--yellow pv3 ph6.5-m ph2">
        <Txt
          size={TxtSize.XSMALL}
          value={t(
            "tutorialComplete",
            "That's it! You should be ready to play now. You can either finish this game or start a new one with friends!\n\nThanks for following along 🎉\n\nYou can access the complete rules and tour by taping the ☰ button"
          )}
        />
        {/* Client-side: in nearby mode, a page load would close the links to the other devices. */}
        {originalGameId && (
          <Link className="mt3" href={gameUrl(originalGameId)}>
            <Button primary size={ButtonSize.SMALL} text={t("backToGame", "Back to game")} />
          </Link>
        )}
        <Button void className="absolute right-0 bottom-0 mb1" text="&times;" onClick={() => setShowTutorial(false)} />
      </div>
    );
  }

  return (
    <div className="flex flex-column bg-black-50 bt b--yellow pv3 ph6.5-m ph2">
      <Txt size={TxtSize.XSMALL}>{action.content}</Txt>
      <Txt className="mt3 txt-yellow" size={TxtSize.SMALL}>
        ➤ {action.todo}
      </Txt>
    </div>
  );
}
