import { ArrowLeftIcon, ArrowRightIcon, LaptopIcon, ServerIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "../../ui/button";
import { SettingsSection } from "../settingsLayout";
import { ArrivalTag, SquareGlyph, squareSentence } from "./LevelControls";
import {
  APP_PARTY_ID,
  REACH_LEVEL_LABELS,
  squareKey,
  type ReachModel,
  type ReachSquare,
} from "./reachModel.logic";

export function EnvironmentMap({ model }: { readonly model: ReachModel }) {
  const [selectedId, setSelectedId] = useState(APP_PARTY_ID);
  const sources = model.rows.filter((party) => party.kind === "app" || party.kind === "server");
  const source = sources.find((party) => party.id === selectedId) ?? sources[0];
  if (!source || model.columns.length === 0) return null;
  const destinations = model.columns.filter((party) => party.id !== source.id);

  return (
    <SettingsSection title="Environment map">
      <div className="space-y-3 px-3 py-3 sm:px-4">
        <div className="flex flex-wrap gap-2" role="group" aria-label="Map focus">
          {sources.map((party) => (
            <Button
              key={party.id}
              size="sm"
              variant={party.id === source.id ? "secondary" : "outline"}
              aria-pressed={party.id === source.id}
              onClick={() => setSelectedId(party.id)}
            >
              {party.kind === "app" ? <LaptopIcon /> : <ServerIcon />}
              {party.label}
            </Button>
          ))}
        </div>
        {destinations.length === 0 ? (
          <p className="text-sm text-muted-foreground">No other servers in this map.</p>
        ) : (
          <ul
            className="space-y-2 border-l border-border pl-3"
            aria-label={`Routes for ${source.label}`}
          >
            {destinations.map((party) => {
              const outbound = model.squares.get(squareKey(source.id, party.id));
              const inbound = model.squares.get(squareKey(party.id, source.id));
              return (
                <li
                  key={party.id}
                  className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg border border-border bg-muted/30 px-3 py-2"
                >
                  <span className="flex min-w-32 items-center gap-2 text-sm font-medium">
                    <ServerIcon aria-hidden className="size-4 text-muted-foreground" />
                    {party.label}
                  </span>
                  {outbound && <MapRoute square={outbound} inbound={false} />}
                  {inbound && <MapRoute square={inbound} inbound />}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </SettingsSection>
  );
}

function MapRoute({
  square,
  inbound,
}: {
  readonly square: ReachSquare;
  readonly inbound: boolean;
}) {
  const Arrow = inbound ? ArrowLeftIcon : ArrowRightIcon;
  const { state } = square;
  return (
    <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
      <span className="sr-only">{squareSentence(square)}</span>
      <Arrow aria-hidden className="size-3.5" />
      <span aria-hidden className="flex items-center gap-1">
        <SquareGlyph state={state} />
        {state.kind === "level" ? REACH_LEVEL_LABELS[state.level] : null}
      </span>
      <ArrivalTag square={square} />
    </span>
  );
}
