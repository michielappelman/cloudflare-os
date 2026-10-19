import { useState } from "react";
import type { RpcStub } from "capnweb";
import { X } from "@phosphor-icons/react";
import type { AuthenticatedApi } from "@gadgets/workshop-shared/api";
import ResourcePicker from "../../ResourcePicker";
import { normalizeResourceUrl } from "../../resourceMatching";
import { GatekeeperIcon } from "../../components/GatekeeperIcon";
import {
  loadDefaultConnections,
  saveDefaultConnections,
  type DefaultConnection,
} from "./defaultConnections";

const INPUT =
  "h-10 w-full rounded-lg border border-kumo-line bg-kumo-base px-3 text-[16px] text-kumo-default placeholder:text-kumo-inactive transition-[border-color,box-shadow] focus:border-kumo-ring focus:outline-none focus:ring-[3px] focus:ring-kumo-ring/15 sm:h-9 sm:text-[14px]";

/**
 * Settings list of the connections every new chat starts with. Adding one works like pasting a
 * resource URL into the composer: type the URL, then pick the account that should open it.
 */
export function DefaultConnectionsSetting({
  api,
  userId,
}: {
  api: RpcStub<AuthenticatedApi>;
  userId: number | string;
}) {
  const [connections, setConnections] = useState(() => loadDefaultConnections(userId));
  const [url, setUrl] = useState("");

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
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] text-kumo-default">
                  {connection.label}
                </span>
                <span className="block truncate text-[12px] text-kumo-subtle">
                  {connection.resourceUrl}
                </span>
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
      <input
        type="url"
        value={url}
        onChange={(event) => setUrl(event.target.value)}
        placeholder="Paste a resource URL to add it"
        aria-label="Resource URL"
        className={INPUT}
      />
      {url.trim() && (
        <ResourcePicker
          authenticatedApi={api}
          searchText={url.trim()}
          compact
          onRefine={(newUrl) => setUrl(newUrl)}
          onSelectAccount={(accountId, vendorId, _resource, account, vendor) => {
            const resourceUrl = normalizeResourceUrl(url.trim());
            const accountName = account.uniqueName ?? account.displayName;
            const entry: DefaultConnection = {
              accountId,
              vendorId,
              resourceUrl,
              label: accountName ? `${vendor.displayName} (${accountName})` : vendor.displayName,
            };
            update([
              ...connections.filter((existing) =>
                existing.accountId !== accountId || existing.resourceUrl !== resourceUrl),
              entry,
            ]);
            setUrl("");
          }}
        />
      )}
    </div>
  );
}
