import { useState, type ReactNode } from "react";
import { AnsiBlock, DiffBlock, JsonBlock, ShikiCodeBlock } from "../code";
import { CheckIcon, FolderIcon, PlusIcon, SearchIcon, SettingsIcon, TrashIcon } from "../icons/Icons";
import { SettingsActions, SettingsList, SettingsListRow, SettingsPage, SettingsRow, SettingsSection, SettingsToolbar, StatePill } from "../settings/SettingsLayout";
import { Button } from "./Button";
import { Dialog } from "./Dialog";
import { EmptyState } from "./EmptyState";
import { IconButton } from "./IconButton";
import { MenuItem, MenuSection, MenuSurface } from "./Menu";
import { SaveState } from "./SaveState";
import { Select } from "./Select";
import { Switch } from "./Switch";
import { Tabs } from "./Tabs";
import { TextArea } from "./TextArea";
import { TextInput } from "./TextInput";
import { Tooltip } from "./Tooltip";

export function UiCatalog(props: { onClose(): void }) {
  const [switchOn, setSwitchOn] = useState(true);
  const [tab, setTab] = useState<"one" | "two">("one");
  const [dialogOpen, setDialogOpen] = useState(false);

  return (
    <div className="ui-catalog-backdrop">
      <section className="ui-catalog" aria-label="UI catalog">
        <header className="ui-catalog-header">
          <div>
            <h2>UI catalog</h2>
            <p>Jasmine primitives used by settings, panels, menus, dialogs, and agent output.</p>
          </div>
          <Button variant="ghost" onClick={props.onClose}>Close</Button>
        </header>

        <div className="ui-catalog-grid">
          <CatalogSection title="Buttons">
            <div className="ui-catalog-row">
              <Button>Default</Button>
              <Button variant="primary">Primary</Button>
              <Button variant="danger">Danger</Button>
              <Button variant="ghost">Ghost</Button>
              <Button variant="quiet">Quiet</Button>
              <Button loading>Loading</Button>
              <Button disabled>Disabled</Button>
            </div>
            <div className="ui-catalog-row">
              <IconButton label="Settings" variant="soft"><SettingsIcon /></IconButton>
              <IconButton label="Add" variant="active"><PlusIcon /></IconButton>
              <IconButton label="Delete" variant="danger"><TrashIcon /></IconButton>
              <Tooltip content="Tooltip sample">
                <Button>Hover target</Button>
              </Tooltip>
            </div>
          </CatalogSection>

          <CatalogSection title="Fields">
            <TextInput value="Searchable value" leftIcon={<SearchIcon />} onChange={() => undefined} />
            <Select value="one" onChange={() => undefined}>
              <option value="one">First option</option>
              <option value="two">Second option</option>
            </Select>
            <TextArea value={"Multiline notes\nstay compact and readable."} onChange={() => undefined} />
            <Switch checked={switchOn} aria-label="Catalog switch" onChange={setSwitchOn} onLabel="On" offLabel="Off" />
            <Switch checked={false} disabled aria-label="Disabled switch" onChange={() => undefined} onLabel="On" offLabel="Off" />
            <Tabs ariaLabel="Catalog tabs" value={tab} onChange={(value) => setTab(value)} tabs={[{ id: "one", label: "Details" }, { id: "two", label: "Preview" }]} />
          </CatalogSection>

          <CatalogSection title="Menus">
            <MenuSurface>
              <MenuSection title="Tools">
                <MenuItem leftIcon={<SearchIcon />} rightMeta="On" active>Web search</MenuItem>
                <MenuItem leftIcon={<FolderIcon />} description="Browse local workspace files">Files</MenuItem>
              </MenuSection>
            </MenuSurface>
          </CatalogSection>

          <CatalogSection title="Settings rows">
            <SettingsPage>
              <SettingsSection>
                <SettingsRow label="Simple row" actions={<Button size="sm">Action</Button>} />
                <SettingsRow label="Switch row" description="Optional helper text is explicit." actions={<Switch checked={switchOn} aria-label="Switch row sample" onChange={setSwitchOn} />} />
              </SettingsSection>
              <SettingsActions state="saved" dirty={false} savedLabel="Saved" onSave={() => undefined} />
              <SettingsToolbar>
                <TextInput placeholder="Search settings" leftIcon={<SearchIcon />} />
                <Button size="sm" leftIcon={<PlusIcon />}>Add</Button>
              </SettingsToolbar>
              <SettingsList ariaLabel="Catalog list">
                <SettingsListRow icon={<FolderIcon />} title="External source" description="C:\\workspace\\jasmine-skills" status={<StatePill tone="accent">Enabled</StatePill>} actions={<Button size="sm">Refresh</Button>} />
              </SettingsList>
            </SettingsPage>
          </CatalogSection>

          <CatalogSection title="States">
            <div className="ui-catalog-row">
              <StatePill>Neutral</StatePill>
              <StatePill tone="success">Connected</StatePill>
              <StatePill tone="danger">Failed</StatePill>
              <StatePill tone="accent">Selected</StatePill>
              <SaveState state="saving" />
              <SaveState state="saved" />
              <SaveState state="failed" />
            </div>
            <EmptyState icon={<CheckIcon />} title="No items" subtitle="Empty states use calm copy and a single action slot." action={<Button size="sm">Create</Button>} />
          </CatalogSection>

          <CatalogSection title="Code and logs">
            <ShikiCodeBlock title="typescript" language="ts" code={"export function hello(name: string) {\n  return `hello ${name}`;\n}"} />
            <DiffBlock title="diff" code={"- old value\n+ new value"} />
            <JsonBlock title="json" code={'{"tool":"read","status":"ok"}'} />
            <AnsiBlock title="terminal" code={"\u001b[32mPASS\u001b[0m npm run build"} />
          </CatalogSection>
        </div>

        <Button onClick={() => setDialogOpen(true)}>Open dialog sample</Button>
        <Dialog
          open={dialogOpen}
          title="Dialog sample"
          body="Dialogs use the same shell as confirmations and settings editors."
          onClose={() => setDialogOpen(false)}
          actions={<Button variant="primary" onClick={() => setDialogOpen(false)}>Done</Button>}
        />
      </section>
    </div>
  );
}

function CatalogSection(props: { children: ReactNode; title: string }) {
  return (
    <section className="ui-catalog-section">
      <h3>{props.title}</h3>
      <div className="ui-catalog-section-body">{props.children}</div>
    </section>
  );
}
