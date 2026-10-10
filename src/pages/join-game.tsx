import { useRouter } from "next/router";
import React, { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import HomeButton from "~/components/homeButton";
import Button, { ButtonSize } from "~/components/ui/button";
import Txt, { TxtSize } from "~/components/ui/txt";
import { logFailedPromise } from "~/lib/errors";
import { PublicGame, subscribeToPublicGames } from "~/lib/network";
import { gameUrl } from "~/lib/routes";

export default function JoinGame() {
  const router = useRouter();
  const { t } = useTranslation();

  const [games, setGames] = useState<PublicGame[]>([]);

  /**
   * Public games in their lobby, as announced by their players' browsers.
   */
  useEffect(() => {
    return subscribeToPublicGames((games) => {
      setGames(games);
    });
  }, []);

  return (
    <div className="w-100 h-100 flex justify-center items-center overflow-y-scroll relative bg-main-dark pa2 pv4-l ph3-l shadow-5 br3">
      <HomeButton className="absolute top-1 right-1" />
      <div className="w-90 h-100 pv4 flex flex-column items-center justify-between">
        {!games.length && (
          <>
            <div>
              <Txt className="nowrap" size={TxtSize.MEDIUM} value={t("noRoom", "No available room")} />
            </div>
            <Button
              className="ma2"
              size={ButtonSize.LARGE}
              text={t("createRoom", "Create a room")}
              onClick={() => router.push("/new-game").catch(logFailedPromise)}
            />
          </>
        )}
        {games.length > 0 && (
          <div>
            <Txt className="nowrap mb6" size={TxtSize.LARGE} value={t("availableRooms", "Available rooms")} />
            {games.map((game) => (
              <div key={game.id} className="flex justify-between items-center mb3 w-100 mt3">
                <Txt className="mr4 silver" value={`${game.playersNames.length} / ${game.playersCount}`} />
                <Txt className="flex-grow-1" value={game.playersNames.join(", ")} />
                <Button
                  className="ml2 flex justify-center"
                  size={ButtonSize.SMALL}
                  text={t("join")}
                  onClick={() => router.push(gameUrl(game.id)).catch(logFailedPromise)}
                />
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
