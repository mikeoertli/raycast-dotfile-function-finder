import {
  Action,
  ActionPanel,
  Detail,
  getPreferenceValues,
  Icon,
  List,
  openExtensionPreferences,
  showToast,
  Toast,
  Keyboard,
} from "@raycast/api";
import { usePromise } from "@raycast/utils";
import { useMemo, useState } from "react";
import { homedir } from "node:os";
import { indexPaths } from "./indexer";
import { openDefinition } from "./editor";
import { createSearchIndex, searchIndex, type Definition, type SearchMode } from "./parser";
import { resultPage } from "./results";
import { version } from "../package.json";

const shortPath = (path: string) => (path.startsWith(homedir() + "/") ? "~" + path.slice(homedir().length) : path);

function preview(item: Definition): string {
  const fence = "`".repeat(Math.max(3, ...Array.from(item.definition.matchAll(/`+/g), (match) => match[0].length + 1)));
  return `${fence}${item.language ?? "sh"}\n${item.definition}\n${fence}`;
}

export default function Command() {
  const { paths, scriptPaths } = getPreferenceValues<{ paths: string; scriptPaths?: string }>();
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<SearchMode>("fuzzy");
  const { data, isLoading, revalidate } = usePromise(indexPaths, [paths, scriptPaths ?? ""]);
  const [page, setPage] = useState(0);
  const index = useMemo(() => createSearchIndex(data?.definitions ?? []), [data]);
  const items = useMemo(() => searchIndex(index, query, mode), [index, query, mode]);
  const visible = resultPage(items, page);
  const counts = useMemo(() => {
    const totals: Record<Definition["kind"], number> = {
      alias: 0,
      "glob alias": 0,
      "suffix alias": 0,
      function: 0,
      script: 0,
    };
    for (const item of data?.definitions ?? []) totals[item.kind]++;
    return totals;
  }, [data]);
  const nextPage = () => setPage(visible.page + 1);
  const previousPage = () => setPage(visible.page - 1);

  async function edit(item: Definition) {
    const toast = await showToast({ style: Toast.Style.Animated, title: "Opening definition…" });
    try {
      await openDefinition(item);
      toast.style = Toast.Style.Success;
      toast.title = "Opened in editor";
    } catch (error) {
      toast.style = Toast.Style.Failure;
      toast.title = "Could not open editor";
      toast.message = (error as Error).message;
    }
  }

  const commonActions = (
    <ActionPanel.Section>
      <Action
        title="Refresh Index"
        icon={Icon.ArrowClockwise}
        shortcut={Keyboard.Shortcut.Common.Refresh}
        onAction={() => {
          setPage(0);
          return revalidate();
        }}
      />
      {visible.page + 1 < visible.pages && (
        <Action
          title="Next Results Page"
          icon={Icon.ArrowRight}
          shortcut={{ modifiers: ["cmd"], key: "]" }}
          onAction={nextPage}
        />
      )}
      {visible.page > 0 && (
        <Action
          title="Previous Results Page"
          icon={Icon.ArrowLeft}
          shortcut={{ modifiers: ["cmd"], key: "[" }}
          onAction={previousPage}
        />
      )}
      <Action.Push
        title="Show Index Summary"
        icon={Icon.Info}
        target={
          <Detail
            markdown={`# Dotfile Finder v${version}\n\n**${data?.definitions.length ?? 0} entries** across **${data?.files ?? 0} files**.\n\n${Object.entries(
              counts,
            )
              .map(([kind, count]) => `- **${kind}:** ${count}`)
              .join(
                "\n",
              )}\n\n**${items.length} matches** for the current search. Showing ${visible.start}–${visible.end}, page ${visible.page + 1} of ${visible.pages}.\n\nSearch always examines the complete index. Only the displayed results are paged.\n\n${data?.warnings.length ? "## Scan warnings\n\n" + data.warnings.map((warning) => `- ${warning}`).join("\n") : "No scan warnings."}`}
          />
        }
      />
      <Action title="Configure Search Paths" icon={Icon.Gear} onAction={openExtensionPreferences} />
      {Boolean(data?.warnings.length) && (
        <Action.Push
          title="Show Scan Warnings"
          icon={Icon.Warning}
          target={<Detail markdown={data!.warnings.map((warning) => `- ${warning}`).join("\n")} />}
        />
      )}
    </ActionPanel.Section>
  );

  return (
    <List
      isLoading={isLoading}
      isShowingDetail
      filtering={false}
      searchText={query}
      onSearchTextChange={(value) => {
        setQuery(value);
        setPage(0);
      }}
      searchBarPlaceholder={
        mode === "exact"
          ? "Exact alias, function or script name (case-insensitive)…"
          : "Fuzzy search names and definitions (spaces, - and _ ignored)…"
      }
      navigationTitle={`Dotfile Finder · ${data?.definitions.length ?? 0} definitions in ${data?.files ?? 0} files${data?.warnings.length ? " · scan warnings" : ""}`}
      searchBarAccessory={
        <List.Dropdown
          tooltip="Match Mode"
          value={mode}
          onChange={(value) => {
            setMode(value as SearchMode);
            setPage(0);
          }}
          storeValue
        >
          <List.Dropdown.Item title="Fuzzy Name & Definition" value="fuzzy" />
          <List.Dropdown.Item title="Exact Name" value="exact" />
        </List.Dropdown>
      }
    >
      <List.EmptyView
        icon={Icon.MagnifyingGlass}
        title={isLoading ? "Reading dotfiles…" : "No matching aliases, functions or scripts"}
        description={
          data?.definitions.length
            ? "Try another name or switch to fuzzy matching."
            : "Configure dotfile paths and script directories in extension preferences."
        }
        actions={<ActionPanel>{commonActions}</ActionPanel>}
      />
      <List.Section
        title={`${items.length.toLocaleString()} matches · ${(data?.definitions.length ?? 0).toLocaleString()} indexed`}
        subtitle={`Showing ${visible.start.toLocaleString()}–${visible.end.toLocaleString()} · Page ${visible.page + 1} of ${visible.pages}`}
      >
        {visible.items.map((item) => (
          <List.Item
            key={item.id}
            id={item.id}
            title={item.name}
            icon={item.kind === "script" ? Icon.Document : item.kind === "function" ? Icon.Code : Icon.Link}
            accessories={[
              {
                text: item.kind,
                tooltip: `${item.kind === "glob alias" ? "Global alias (alias -g) · " : ""}${shortPath(item.file)}:${item.line}`,
              },
            ]}
            detail={
              <List.Item.Detail
                markdown={preview(item)}
                metadata={
                  <List.Item.Detail.Metadata>
                    <List.Item.Detail.Metadata.Label title="Name" text={item.name} />
                    <List.Item.Detail.Metadata.Label title="Type" text={item.kind} />
                    <List.Item.Detail.Metadata.Label title="File" text={shortPath(item.file)} />
                    <List.Item.Detail.Metadata.Label title="Line" text={String(item.line)} />
                  </List.Item.Detail.Metadata>
                }
              />
            }
            actions={
              <ActionPanel>
                <ActionPanel.Section>
                  <Action.CopyToClipboard title="Copy Name" content={item.name} />
                  <Action.CopyToClipboard
                    title={item.kind === "script" ? "Copy Script Contents" : "Copy Definition"}
                    content={item.definition}
                    shortcut={Keyboard.Shortcut.Common.Copy}
                  />
                  <Action
                    title="Open in VISUAL or EDITOR"
                    icon={Icon.Pencil}
                    shortcut={Keyboard.Shortcut.Common.Edit}
                    onAction={() => edit(item)}
                  />
                  <Action.ShowInFinder path={item.file} />
                </ActionPanel.Section>
                {commonActions}
              </ActionPanel>
            }
          />
        ))}
      </List.Section>
      {items.length > 0 && visible.pages > 1 && (
        <List.Section title="Result Pages">
          {visible.page + 1 < visible.pages && (
            <List.Item
              id="next-results-page"
              title={`Next Results · Page ${visible.page + 2} of ${visible.pages}`}
              icon={Icon.ArrowRight}
              actions={
                <ActionPanel>
                  <Action title="Next Results Page" onAction={nextPage} />
                  {commonActions}
                </ActionPanel>
              }
            />
          )}
          {visible.page > 0 && (
            <List.Item
              id="previous-results-page"
              title={`Previous Results · Page ${visible.page} of ${visible.pages}`}
              icon={Icon.ArrowLeft}
              actions={
                <ActionPanel>
                  <Action title="Previous Results Page" onAction={previousPage} />
                  {commonActions}
                </ActionPanel>
              }
            />
          )}
        </List.Section>
      )}
    </List>
  );
}
