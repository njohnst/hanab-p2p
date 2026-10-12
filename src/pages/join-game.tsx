import { useRouter } from "next/router";
import React, { FormEvent, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import HomeButton from "~/components/homeButton";
import Button, { ButtonSize } from "~/components/ui/button";
import { TextInput } from "~/components/ui/forms";
import Txt, { TxtSize } from "~/components/ui/txt";
import { logFailedPromise } from "~/lib/errors";
import { PublicGame, subscribeToPublicGames } from "~/lib/network";
import { gameUrl, parseGameReference } from "~/lib/routes";

export default function JoinGame() {
  const router = useRouter();
  const { t } = useTranslation();

  const [games, setGames] = useState<PublicGame[]>([]);
  const [reference, setReference] = useState("");
  const [invalidReference, setInvalidReference] = useState(false);

  /**
   * Public games in their lobby, as announced by their players' browsers.
   */
  useEffect(() => {
    return subscribeToPublicGames((games) => {
      setGames(games);
    });
  }, []);

  /**
   * Join a room by its name or link, e.g. one a friend sent for a private game.
   */
  function onReferenceSubmit(e: FormEvent) {
    e.preventDefault();

    const gameId = parseGameReference(reference);
    if (!gameId) {
      setInvalidReference(true);
      return;
    }

    router.push(gameUrl(gameId)).catch(logFailedPromise);
  }

  return (
    <div className="w-100 h-100 overflow-y-scroll relative bg-main-dark pa2 pv4-l ph3-l shadow-5 br3">
      <HomeButton className="absolute top-1 right-1" />
      <div className="center mw6 w-100 ph2 pv4 flex flex-column">
        <form noValidate className="w-100 mb5" onSubmit={onReferenceSubmit}>
          <label className="db mb3" htmlFor="game-reference">
            <Txt size={TxtSize.MEDIUM} value={t("joinWithReference", "Join with a room name or link")} />
          </label>
          <div className="flex">
            <TextInput
              aria-describedby={invalidReference ? "game-reference-error" : undefined}
              aria-invalid={invalidReference}
              autoCapitalize="off"
              autoComplete="off"
              autoCorrect="off"
              className="flex-auto h-auto f5 mr2"
              enterKeyHint="go"
              id="game-reference"
              placeholder={t("gameReferencePlaceholder", "e.g. ExcitingHookwormPink")}
              spellCheck={false}
              value={reference}
              onChange={(e) => {
                setReference(e.target.value);
                setInvalidReference(false);
              }}
            />
            <Button primary disabled={!reference.trim()} id="join-by-reference" text={t("join")} type="submit" />
          </div>
          {invalidReference && (
            <Txt
              className="db mt2 light-red"
              id="game-reference-error"
              role="alert"
              value={t(
                "invalidGameReference",
                "That isn't a room name or link. Room names look like ExcitingHookwormPink."
              )}
            />
          )}
        </form>

        <section className="w-100">
          <Txt className="db mb3" size={TxtSize.MEDIUM} value={t("publicRooms", "Public rooms")} />
          {!games.length && (
            <div className="flex flex-column items-center">
              <Txt
                className="db lavender mb4 w-100"
                value={t(
                  "publicRoomsExplanation",
                  "Public rooms show up here while their players wait in the lobby. To join a private room, ask its players for its name or link."
                )}
              />
              <Button
                size={ButtonSize.LARGE}
                text={t("createRoom", "Create a room")}
                onClick={() => router.push("/new-game").catch(logFailedPromise)}
              />
            </div>
          )}
          {games.map((game) => (
            <div key={game.id} className="flex items-center pv2 bb b--yellow-light">
              <Txt className="mr3 silver nowrap" value={`${game.playersNames.length} / ${game.playersCount}`} />
              <Txt
                className="flex-auto mr2"
                style={{ overflowWrap: "anywhere" }}
                value={game.playersNames.join(", ")}
              />
              <Button
                size={ButtonSize.SMALL}
                text={t("join")}
                onClick={() => router.push(gameUrl(game.id)).catch(logFailedPromise)}
              />
            </div>
          ))}
        </section>
      </div>
    </div>
  );
}
