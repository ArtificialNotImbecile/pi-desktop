import { useState } from "react";
import type {
  RemoteDoctorReport,
  RemoteEgressMode,
  RemoteProfileCreateRequest,
  RemoteProfileSummary
} from "../../../shared/ipc";
import { useI18n, type I18nKey } from "../../i18n";
import { Button, Dialog, StatusPill, TextInput } from "../ui";

type WizardStep = "host" | "network" | "check";

const STEP_ORDER: WizardStep[] = ["host", "network", "check"];
const STEP_LABELS: Record<WizardStep, I18nKey> = {
  host: "remote.wizard.stepHost",
  network: "remote.wizard.stepNetwork",
  check: "remote.wizard.stepCheck"
};

/**
 * Three steps rather than one form because the last one is not a field: the
 * first connection uploads the managed runtime, which needs its own visible,
 * repeatable stage instead of hiding behind a Save button.
 */
export function RemoteProfileWizard(props: {
  open: boolean;
  onClose(): void;
  onCreate(request: RemoteProfileCreateRequest): Promise<RemoteProfileSummary | null>;
  onCheck(profileId: string): Promise<RemoteDoctorReport | null>;
  onInstall(profileId: string): Promise<boolean>;
}) {
  const { t } = useI18n();
  const [step, setStep] = useState<WizardStep>("host");
  const [name, setName] = useState("");
  const [sshHost, setSshHost] = useState("");
  const [sshPort, setSshPort] = useState("");
  const [defaultCwd, setDefaultCwd] = useState("");
  const [networkMode, setNetworkMode] = useState<RemoteEgressMode>("remote-direct");
  const [allowedPorts, setAllowedPorts] = useState("80, 443");
  const [noProxy, setNoProxy] = useState("");
  const [upstreamProxyEnv, setUpstreamProxyEnv] = useState("");
  const [created, setCreated] = useState<RemoteProfileSummary | null>(null);
  const [report, setReport] = useState<RemoteDoctorReport | null>(null);
  const [busy, setBusy] = useState(false);

  function reset() {
    setStep("host");
    setName("");
    setSshHost("");
    setSshPort("");
    setDefaultCwd("");
    setNetworkMode("remote-direct");
    setAllowedPorts("80, 443");
    setNoProxy("");
    setUpstreamProxyEnv("");
    setCreated(null);
    setReport(null);
  }

  function close() {
    reset();
    props.onClose();
  }

  const hostStepReady = name.trim().length > 0 && sshHost.trim().length > 0;

  async function createProfile() {
    setBusy(true);
    try {
      const profile = await props.onCreate({
        name: name.trim(),
        sshHost: sshHost.trim(),
        sshPort: sshPort.trim() ? Number(sshPort.trim()) : null,
        defaultCwd: defaultCwd.trim() || null,
        networkMode,
        ...(networkMode === "client-proxy" ? {
          noProxy: splitList(noProxy),
          allowedPorts: splitList(allowedPorts).map(Number).filter((port) => Number.isInteger(port) && port > 0),
          upstreamProxyEnv: upstreamProxyEnv.trim() || null
        } : {})
      });
      if (profile) {
        setCreated(profile);
        setStep("check");
      }
    } finally {
      setBusy(false);
    }
  }

  async function runCheck(profileId: string) {
    setBusy(true);
    try {
      setReport(await props.onCheck(profileId));
    } finally {
      setBusy(false);
    }
  }

  async function install(profileId: string) {
    setBusy(true);
    try {
      if (await props.onInstall(profileId)) await runCheck(profileId);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={props.open}
      onClose={close}
      title={t("remote.wizard.title")}
      className="remote-wizard"
      actions={renderActions()}
    >
      <ol className="remote-wizard-steps">
        {STEP_ORDER.map((item) => (
          <li key={item} className={stepClass(item, step, created)}>
            {t(STEP_LABELS[item])}
          </li>
        ))}
      </ol>

      {step === "host" ? (
        <div className="remote-wizard-fields">
          <Field label={t("remote.wizard.name")}>
            <TextInput
              value={name}
              aria-label={t("remote.wizard.name")}
              placeholder={t("remote.wizard.namePlaceholder")}
              onChange={(event) => setName(event.target.value)}
            />
          </Field>
          <Field label={t("remote.wizard.host")}>
            <TextInput
              value={sshHost}
              aria-label={t("remote.wizard.host")}
              placeholder={t("remote.wizard.hostPlaceholder")}
              onChange={(event) => setSshHost(event.target.value)}
            />
          </Field>
          <Field label={t("remote.wizard.port")}>
            <TextInput
              value={sshPort}
              inputMode="numeric"
              aria-label={t("remote.wizard.port")}
              placeholder={t("remote.wizard.portPlaceholder")}
              onChange={(event) => setSshPort(event.target.value)}
            />
          </Field>
          <Field label={t("remote.wizard.cwd")}>
            <TextInput
              value={defaultCwd}
              aria-label={t("remote.wizard.cwd")}
              placeholder={t("remote.wizard.cwdPlaceholder")}
              onChange={(event) => setDefaultCwd(event.target.value)}
            />
          </Field>
        </div>
      ) : null}

      {step === "network" ? (
        <div className="remote-wizard-fields">
          <fieldset className="remote-egress-choice">
            <legend>{t("remote.egress.label")}</legend>
            {(["remote-direct", "client-proxy"] as const).map((mode) => (
              <label key={mode} className={networkMode === mode ? "selected" : ""}>
                <input
                  type="radio"
                  name="remote-egress"
                  checked={networkMode === mode}
                  onChange={() => setNetworkMode(mode)}
                />
                <span className="remote-egress-name">
                  {mode === "client-proxy" ? t("remote.egress.proxy") : t("remote.egress.direct")}
                </span>
                <small>{mode === "client-proxy" ? t("remote.egress.proxyDescription") : t("remote.egress.directDescription")}</small>
              </label>
            ))}
          </fieldset>
          <p className="remote-wizard-hint">{t("remote.egress.locked")}</p>

          {networkMode === "client-proxy" ? (
            <>
              <Field label={t("remote.wizard.allowedPorts")}>
                <TextInput
                  value={allowedPorts}
                  aria-label={t("remote.wizard.allowedPorts")}
                  placeholder={t("remote.wizard.allowedPortsPlaceholder")}
                  onChange={(event) => setAllowedPorts(event.target.value)}
                />
              </Field>
              <Field label={t("remote.wizard.noProxy")} hint={t("remote.wizard.noProxyHint")}>
                <TextInput
                  value={noProxy}
                  aria-label={t("remote.wizard.noProxy")}
                  placeholder={t("remote.wizard.noProxyPlaceholder")}
                  onChange={(event) => setNoProxy(event.target.value)}
                />
              </Field>
              <Field label={t("remote.wizard.upstreamProxy")} hint={t("remote.wizard.upstreamProxyHint")}>
                <TextInput
                  value={upstreamProxyEnv}
                  aria-label={t("remote.wizard.upstreamProxy")}
                  placeholder={t("remote.wizard.upstreamProxyPlaceholder")}
                  onChange={(event) => setUpstreamProxyEnv(event.target.value)}
                />
              </Field>
              <p className="remote-wizard-notice">{t("remote.wizard.proxyNotice")}</p>
            </>
          ) : null}
        </div>
      ) : null}

      {step === "check" && created ? (
        <div className="remote-wizard-check">
          <p className="remote-wizard-hint">{t("remote.wizard.created")}</p>
          {report ? (
            <ul className="remote-doctor-list">
              {report.checks.map((check) => (
                <li key={check.id}>
                  <StatusPill tone={checkTone(check.status)}>{t(checkStatusKey(check.status))}</StatusPill>
                  <span>{check.message}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="remote-wizard-hint">{t("remote.doctor.notRun")}</p>
          )}
          <p className="remote-wizard-hint">{t("remote.wizard.installHint")}</p>
        </div>
      ) : null}
    </Dialog>
  );

  function renderActions() {
    if (step === "host") {
      return (
        <>
          <Button variant="ghost" onClick={close}>{t("app.cancel")}</Button>
          <Button variant="primary" disabled={!hostStepReady} onClick={() => setStep("network")}>
            {t("remote.wizard.next")}
          </Button>
        </>
      );
    }
    if (step === "network") {
      return (
        <>
          <Button variant="ghost" onClick={() => setStep("host")}>{t("remote.wizard.back")}</Button>
          <Button variant="primary" loading={busy} onClick={() => void createProfile()}>
            {t("remote.wizard.create")}
          </Button>
        </>
      );
    }
    return (
      <>
        <Button variant="ghost" disabled={busy || !created} onClick={() => created && void runCheck(created.id)}>
          {t("remote.doctor.run")}
        </Button>
        <Button variant="default" loading={busy} disabled={!created} onClick={() => created && void install(created.id)}>
          {t("remote.wizard.installRuntime")}
        </Button>
        <Button variant="primary" onClick={close}>{t("app.close")}</Button>
      </>
    );
  }
}

function Field(props: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="remote-wizard-field">
      <span className="remote-wizard-label">{props.label}</span>
      {props.children}
      {props.hint ? <small className="remote-wizard-hint">{props.hint}</small> : null}
    </div>
  );
}

function stepClass(item: WizardStep, current: WizardStep, created: RemoteProfileSummary | null): string {
  if (item === current) return "current";
  const done = STEP_ORDER.indexOf(item) < STEP_ORDER.indexOf(current) || (item !== "check" && created !== null);
  return done ? "done" : "";
}

function checkTone(status: RemoteDoctorReport["checks"][number]["status"]): "success" | "danger" | "warning" | "neutral" {
  if (status === "pass") return "success";
  if (status === "fail") return "danger";
  if (status === "warning") return "warning";
  return "neutral";
}

function checkStatusKey(status: RemoteDoctorReport["checks"][number]["status"]): I18nKey {
  return `remote.doctor.${status}` as I18nKey;
}

function splitList(value: string): string[] {
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}
