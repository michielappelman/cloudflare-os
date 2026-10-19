import { useState } from "react";
import { Plus, X } from "@phosphor-icons/react";
import GatekeeperModal from "../../GatekeeperModal";
import { GatekeeperIcon } from "../../components/GatekeeperIcon";
import {
  loadDefaultConnections,
  saveDefaultConnections,
  type DefaultConnection,
} from "./defaultConnections";

/**
 * Settings list of the connections every new chat starts with. Adding one uses the same dialog as
 * attaching a connection in the composer, in choose-only mode: it records the account and resource
 * the user picks, and the Home composer creates the connection for each new chat.
 */
export function DefaultConnectionsSetting({ userId }: { userId: number | string }) {
  const [connections, setConnections] = useState(() => loadDefaultConnections(userId));
  const [adding, setAdding] = useState(false);

  const update = (next: DefaultConnection[]) => {
    saveDefaultConnections(userId, next);
    setConnections(next);
  };

  return (
    <div className="flex flex-col gap-3 px-5 py-4">
      <p className="text-[13px] tracking-[-0.1px] text-kumo-subtle">
        New chats start with these connections attached. You can still remove them from a
        message before sending it.
      </p>
      {connections.length > 0 && (
        <ul className="flex flex-col divide-y divide-kumo-line rounded-lg border border-kumo-line">
          {connections.map((connection) => (
            <li
              key={`${connection.accountId} ${connection.resourceUrl}`}
              className="flex items-center gap-2 px-3 py-2"
            >
              <GatekeeperIcon vendorId={connection.vendorId} fallbackText={connection.label} size={16} />
              <span className="min-w-0 flex-1 truncate text-[13px] text-kumo-default">
                {connection.label}
              </span>
              <button
                type="button"
                aria-label={`Remove ${connection.label}`}
                onClick={() => update(connections.filter((entry) => entry !== connection))}
                className="press grid h-8 w-8 shrink-0 cursor-pointer place-items-center rounded-lg text-kumo-inactive transition-colors hover:bg-kumo-tint hover:text-kumo-default"
              >
                <X size={14} />
              </button>
            </li>
          ))}
        </ul>
      )}
      <button
        type="button"
        onClick={() => setAdding(true)}
        className="press inline-flex h-9 w-fit cursor-pointer items-center gap-1.5 rounded-lg border border-kumo-line px-3 text-[13px] font-medium tracking-[-0.25px] text-kumo-default transition-colors hover:bg-kumo-tint"
      >
        <Plus size={14} />
        Add connection
      </button>
      <GatekeeperModal
        open={adding}
        onClose={() => setAdding(false)}
        onChosen={(choice) => update([
          ...connections.filter((existing) =>
            existing.accountId !== choice.accountId || existing.resourceUrl !== choice.resourceUrl),
          choice,
        ])}
      />
    </div>
  );
}
