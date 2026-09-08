import { useEffect, useMemo, useRef, useState } from "react";
import { useIDEStore } from "@/store/ideStore";
import { validateGitHubToken } from "@/lib/githubClient";
import { AEROLINK_COMPATIBLE_BASE_URL, AEROLINK_DEFAULT_MODEL, AEROLINK_MODELS, PROVIDERS, catalogModels, isAerolinkKey, providerLabel, refreshProviderModels, resolveProvider, suggestProviderForKey, validateAPIKey, type AIModelOption } from "@/lib/aiClient";
import { connectPuterSession } from "@/lib/puterClient";
import { getWorkspaceLifecycle, setWorkspaceKeepAlive, type WorkspaceLifecycle } from "@/lib/backendRunner";
import type { AIProvider } from "@/types/ide";
import { toast } from "sonner";
import developerPortrait from "@/assets/saqlain-developer.jpg";
type ToggleProps = {
    checked: boolean;
    onChange: (v: boolean) => void;
};
function Toggle({ checked, onChange }: ToggleProps) {
    return (<label className="toggle">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)}/>
      <span className="toggle-track"/>
    </label>);
}
type NavItem = {
    id: string;
    label: string;
    icon: React.ReactNode;
};
const NAV: NavItem[] = [
    {
        id: "editor", label: "Editor",
        icon: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>,
    },
    {
        id: "ai", label: "AI Assistant",
        icon: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="18" height="18" rx="4"/><path d="M9 9h.01M15 9h.01M9 15h6"/></svg>,
    },
    {
        id: "github", label: "GitHub",
        icon: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.87a3.37 3.37 0 0 0-.94-2.61c3.14-.35 6.44-1.54 6.44-7A5.44 5.44 0 0 0 20 4.77 5.07 5.07 0 0 0 19.91 1S18.73.65 16 2.48a13.38 13.38 0 0 0-7 0C6.27.65 5.09 1 5.09 1A5.07 5.07 0 0 0 5 4.77 5.44 5.44 0 0 0 3.5 8.55c0 5.42 3.3 6.61 6.44 7A3.37 3.37 0 0 0 9 18.13V22"/></svg>,
    },
    {
        id: "about", label: "About",
        icon: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>,
    },
];
export default function SettingsPanel() {
    const { settings, settingsTab, setSettingsTab, setShowSettings, updateEditorSettings, updateAISettings, updateGithubSettings, } = useIDEStore();
    const [keyInput, setKeyInput] = useState(settings.ai.apiKey);
    const [endpointInput, setEndpointInput] = useState(settings.ai.apiEndpoint);
    const [modelInput, setModelInput] = useState(settings.ai.model);
    const [providerInput, setProviderInput] = useState<AIProvider>(settings.ai.provider);
    const [tokenInput, setTokenInput] = useState(settings.github.token);
    const [showKey, setShowKey] = useState(false);
    const [showProviderForm, setShowProviderForm] = useState(() => !settings.ai.apiKey);
    const [showToken, setShowToken] = useState(false);
    const [checking, setChecking] = useState(false);
    const [refreshingModels, setRefreshingModels] = useState(false);
    const [modelSearch, setModelSearch] = useState("");
    const [customModelDraft, setCustomModelDraft] = useState("");
    const [liveModels, setLiveModels] = useState<AIModelOption[]>([]);
    const [connectionDetail, setConnectionDetail] = useState("");
    const [puterConnecting, setPuterConnecting] = useState(false);
    const [workspaceLifecycle, setWorkspaceLifecycle] = useState<WorkspaceLifecycle | null>(null);
    const matchingModelPresets = useMemo(() => {
        const query = modelSearch.trim().toLowerCase();
        const models = [...liveModels, ...(isAerolinkKey(keyInput) ? AEROLINK_MODELS : []), ...catalogModels(providerInput, settings.ai.customModels)];
        const unique = models.filter((item, index, list) => list.findIndex((entry) => entry.id === item.id) === index);
        return query ? unique.filter((model) => `${model.label} ${model.id} ${model.family}`.toLowerCase().includes(query)) : unique;
    }, [liveModels, modelSearch, providerInput, settings.ai.customModels]);
    async function handleConnectKey() {
        if (!keyInput.trim()) {
            toast.error("Paste your API key first");
            return;
        }
        setChecking(true);
        setConnectionDetail("");
        try {
            const result = await validateAPIKey({ key: keyInput, provider: providerInput, endpoint: endpointInput, model: modelInput });
            updateAISettings({ apiKey: keyInput.trim(), apiEndpoint: endpointInput.trim(), model: result.model, provider: result.provider, keyStatus: result.status });
            setProviderInput(result.provider);
            setModelInput(result.model);
            setConnectionDetail(result.detail || "");
            if (result.status === "valid") {
                setShowProviderForm(false);
                toast.success(`${providerLabel(result.provider)} connected`);
            }
            else if (result.status === "invalid") toast.error("The provider rejected this API key");
            else if (result.status === "permission_denied") toast.error("The key works but does not have access to this model");
            else if (result.status === "credits_exhausted") toast.error("The provider reports that credits or a spend limit are exhausted");
            else if (result.status === "rate_limited") toast.error("The provider rate limit is active. Wait and try again.");
            else if (result.status === "unreachable") toast.error("The provider could not be reached from this browser or backend.");
            else toast.error("Connection needs attention. Read the status below.");
        }
        finally {
            setChecking(false);
        }
    }
    async function handleValidateToken() {
        if (!tokenInput.trim()) {
            toast.error("Paste your GitHub token first");
            return;
        }
        const { valid, username } = await validateGitHubToken(tokenInput.trim());
        if (valid) {
            updateGithubSettings({ token: tokenInput.trim(), username });
            toast.success(`Connected as @${username}`);
        }
        else {
            toast.error("Invalid GitHub token");
        }
    }
    function handleClearApiKey() {
        setKeyInput("");
        setShowProviderForm(true);
        updateAISettings({ apiKey: "", keyStatus: "none" });
        toast.success("Your API key was removed from this browser");
    }
    async function connectFreePuter() {
        setPuterConnecting(true);
        try {
            await connectPuterSession();
            updateAISettings({ usePuter: true });
            toast.success("Free Puter AI is connected in this browser");
        }
        catch (error) {
            toast.error(error instanceof Error ? error.message : "Puter sign-in was cancelled or failed.");
        }
        finally {
            setPuterConnecting(false);
        }
    }
    function updateProvider(value: AIProvider) {
        setProviderInput(value);
        setLiveModels([]);
        setConnectionDetail("");
        if (value !== "auto" && value !== "compatible" && !modelInput.trim()) setModelInput(catalogModels(value)[0]?.id || "");
    }
    function handleKeyChange(value: string) {
        setKeyInput(value);
        if (isAerolinkKey(value)) {
            updateProvider("compatible");
            setEndpointInput(AEROLINK_COMPATIBLE_BASE_URL);
            if (!modelInput.trim()) setModelInput(AEROLINK_DEFAULT_MODEL);
            return;
        }
        if (providerInput === "auto") {
            const suggestion = suggestProviderForKey(value);
            if (suggestion) updateProvider(suggestion);
        }
    }
    function selectModel(model: AIModelOption) {
        setModelInput(model.id);
        setModelSearch("");
        toast.success(`${model.label} selected`);
    }
    function addCustomModel() {
        const value = customModelDraft.trim();
        if (!value) {
            toast.error("Enter the exact model ID first");
            return;
        }
        const customModels = Array.from(new Set([...settings.ai.customModels, value]));
        updateAISettings({ customModels, model: value });
        setModelInput(value);
        setCustomModelDraft("");
        toast.success("Custom model added to this browser");
    }
    async function refreshModels() {
        if (!keyInput.trim()) {
            toast.error("Paste the provider key before refreshing its available models");
            return;
        }
        setRefreshingModels(true);
        try {
            const provider = resolveProvider(providerInput, keyInput);
            const models = await refreshProviderModels(provider, keyInput, endpointInput);
            setLiveModels(models);
            toast.success(`${models.length} available ${providerLabel(provider)} models loaded`);
        }
        catch (error) {
            const detail = error instanceof Error ? error.message : "The model catalogue could not be refreshed.";
            setConnectionDetail(detail);
            toast.error(detail);
        }
        finally {
            setRefreshingModels(false);
        }
    }
    function handleDisconnectGitHub() {
        setTokenInput("");
        updateGithubSettings({ token: "", username: "", codespaceActive: "" });
        toast.success("GitHub was disconnected from this browser");
    }
    const keyStatus = settings.ai.keyStatus;
    useEffect(() => {
      const sessionId = localStorage.getItem("sk-coder-workspace-session-id");
      if (!sessionId)
        return;
      void getWorkspaceLifecycle(sessionId).then(setWorkspaceLifecycle).catch(() => setWorkspaceLifecycle(null));
    }, []);
    async function toggleWorkspaceKeepAlive(keepAlive: boolean) {
      if (!workspaceLifecycle)
        return;
      try {
        setWorkspaceLifecycle(await setWorkspaceKeepAlive(workspaceLifecycle.id, keepAlive));
        toast.success(keepAlive ? "Workspace will stay active while idle" : "Workspace idle suspension restored");
      }
      catch (error) {
        toast.error(error instanceof Error ? error.message : "Workspace setting could not be updated.");
      }
    }
    return (<div className="settings-overlay" onClick={() => setShowSettings(false)}>
      <div className="settings-panel" onClick={(e) => e.stopPropagation()}>
        <div className="settings-header">
          <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2">
              <circle cx="12" cy="12" r="3"/>
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
            </svg>
            <h2>Settings</h2>
          </div>
          <button className="btn-icon" onClick={() => setShowSettings(false)} title="Close">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>

        <div className="settings-body">
          <nav className="settings-nav">
            {NAV.map((item) => (<div key={item.id} className={`settings-nav-item ${settingsTab === item.id ? "active" : ""}`} onClick={() => setSettingsTab(item.id)}>
                {item.icon}
                <span>{item.label}</span>
              </div>))}
          </nav>

          <div className="settings-content">

            {settingsTab === "editor" && (<>
                <div className="settings-section">
                  <div className="settings-section-title">Appearance</div>
                  <div className="settings-row">
                    <label>Font Size</label>
                    <input type="number" min={10} max={24} style={{ maxWidth: 70 }} value={settings.editor.fontSize} onChange={(e) => updateEditorSettings({ fontSize: Number(e.target.value) })}/>
                  </div>
                  <div className="settings-row">
                    <label>Font Family</label>
                    <select value={settings.editor.fontFamily} onChange={(e) => updateEditorSettings({ fontFamily: e.target.value })} style={{ maxWidth: 190 }}>
                      <option value="'JetBrains Mono', 'Fira Code', monospace">JetBrains Mono</option>
                      <option value="'Fira Code', monospace">Fira Code</option>
                      <option value="'Cascadia Code', monospace">Cascadia Code</option>
                      <option value="'Courier New', monospace">Courier New</option>
                      <option value="monospace">System Mono</option>
                    </select>
                  </div>
                  <div className="settings-row">
                    <label>Tab Size</label>
                    <select style={{ maxWidth: 80 }} value={settings.editor.tabSize} onChange={(e) => updateEditorSettings({ tabSize: Number(e.target.value) })}>
                      <option value={2}>2 spaces</option>
                      <option value={4}>4 spaces</option>
                      <option value={8}>8 spaces</option>
                    </select>
                  </div>
                  <div className="settings-row">
                    <label>Cursor Style</label>
                    <select style={{ maxWidth: 110 }} value={settings.editor.cursorStyle} onChange={(e) => updateEditorSettings({ cursorStyle: e.target.value as "line" | "block" | "underline" })}>
                      <option value="line">Line</option>
                      <option value="block">Block</option>
                      <option value="underline">Underline</option>
                    </select>
                  </div>
                </div>
                <div className="settings-section">
                  <div className="settings-section-title">Behavior</div>
                  <div className="settings-row"><label>Word Wrap</label><Toggle checked={settings.editor.wordWrap === "on"} onChange={(v) => updateEditorSettings({ wordWrap: v ? "on" : "off" })}/></div>
                  <div className="settings-row"><label>Minimap</label><Toggle checked={settings.editor.minimap} onChange={(v) => updateEditorSettings({ minimap: v })}/></div>
                  <div className="settings-row"><label>Line Numbers</label><Toggle checked={settings.editor.lineNumbers === "on"} onChange={(v) => updateEditorSettings({ lineNumbers: v ? "on" : "off" })}/></div>
                  <div className="settings-row"><label>Auto Save</label><Toggle checked={settings.editor.autoSave} onChange={(v) => updateEditorSettings({ autoSave: v })}/></div>
                  {workspaceLifecycle && <div className="settings-row"><div><label>Keep workspace active</label><div className="settings-hint">Keep the connected server workspace running during idle periods. Retention, capacity, and explicit deletion still apply.</div></div><Toggle checked={workspaceLifecycle.keepAlive} onChange={(v) => void toggleWorkspaceKeepAlive(v)}/></div>}
                  <div className="settings-row"><label>Bracket Colors</label><Toggle checked={settings.editor.bracketPairs} onChange={(v) => updateEditorSettings({ bracketPairs: v })}/></div>
                  <div className="settings-row"><label>Smooth Scroll</label><Toggle checked={settings.editor.smoothScrolling} onChange={(v) => updateEditorSettings({ smoothScrolling: v })}/></div>
                </div>
              </>)}

            {settingsTab === "ai" && (<>
                <div className="settings-section">
                  <div className="settings-section-title">Free Puter AI</div>
                  <div className="settings-hint">Connect free Puter AI in this browser. It does not replace your provider-key configuration.</div>
                  <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.65rem", flexWrap: "wrap" }}>
                    <button className="btn btn-primary" onClick={() => void connectFreePuter()} disabled={puterConnecting}>{puterConnecting ? "Connecting..." : settings.ai.usePuter ? "Reconnect free Puter AI" : "Connect free Puter AI"}</button>
                    {settings.ai.usePuter && <button className="btn btn-ghost" onClick={() => updateAISettings({ usePuter: false })}>Use provider key instead</button>}
                  </div>
                </div>
                {settings.ai.apiKey && !showProviderForm ? <div className="settings-section">
                  <div className="settings-section-title">Connected AI Provider</div>
                  <div className="settings-connected-provider">
                    <div><strong>{providerLabel(settings.ai.provider)}</strong><span>{settings.ai.model || "Connected provider"}</span></div>
                    <button className="btn btn-secondary" onClick={() => { setKeyInput(""); setShowProviderForm(true); }}>Add new key</button>
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "0.5rem", marginTop: "0.6rem" }}>
                    <span className="settings-hint" style={{ margin: 0 }}>No API key is exported with project or connector settings.</span>
                    <button className="btn btn-ghost" onClick={handleClearApiKey} style={{ fontSize: 11, padding: "0.2rem 0.45rem" }}>Remove key</button>
                  </div>
                </div> : <div className="settings-section">
                  <div className="settings-section-title">Connect Your AI Provider</div>
                  <div className="settings-hint" style={{ marginBottom: "0.7rem" }}>Paste one provider key. SK Coder suggests a provider from its visible format, then verifies the connection with the real provider. Your key stays in this browser until you remove it.</div>
                  <div className="settings-row col">
                    <label>API key</label>
                    <div style={{ display: "flex", gap: "0.4rem", alignItems: "center", width: "100%" }}>
                      <input type={showKey ? "text" : "password"} value={keyInput} onChange={(e) => handleKeyChange(e.target.value)} placeholder="Paste an API key" style={{ fontFamily: "var(--font-code)", fontSize: 11, flex: 1 }} onKeyDown={(e) => e.key === "Enter" && void handleConnectKey()}/>
                      <button className="btn btn-ghost" style={{ padding: "0.25rem 0.5rem", flexShrink: 0 }} onClick={() => setShowKey(!showKey)}>{showKey ? "Hide" : "Show"}</button>
                    </div>
                    {suggestProviderForKey(keyInput) && <span className="settings-hint" style={{ marginTop: "0.4rem" }}>Suggested from key: {providerLabel(suggestProviderForKey(keyInput) || "auto")}. This suggestion is verified only when you connect.</span>}
                  </div>
                  <div className="settings-row col" style={{ marginTop: "0.7rem" }}>
                    <label>Provider</label>
                    <select value={providerInput} onChange={(e) => updateProvider(e.target.value as AIProvider)}>
                      {PROVIDERS.map((provider) => <option key={provider.id} value={provider.id}>{provider.label}</option>)}
                    </select>
                    <span className="settings-hint" style={{ marginTop: "0.4rem" }}>{PROVIDERS.find((provider) => provider.id === providerInput)?.description}</span>
                  </div>
                  <div className="settings-row col" style={{ marginTop: "0.7rem" }}>
                    <label>Model</label>
                    <div style={{ display: "flex", gap: "0.4rem" }}>
                      <input value={modelSearch} onChange={(e) => setModelSearch(e.target.value)} placeholder="Search models and versions" style={{ fontSize: 11, flex: 1 }}/>
                      <button className="btn btn-ghost" style={{ padding: "0.25rem 0.5rem", flexShrink: 0 }} onClick={() => void refreshModels()} disabled={refreshingModels}>{refreshingModels ? "Refreshing..." : "Refresh"}</button>
                    </div>
                    <select value={modelInput} onChange={(e) => {
                        const model = matchingModelPresets.find((item) => item.id === e.target.value);
                        if (model) selectModel(model);
                        else setModelInput(e.target.value);
                    }} style={{ marginTop: "0.45rem", width: "100%" }}>
                      <option value="">Select a model</option>
                      {matchingModelPresets.map((model) => <option key={model.id} value={model.id}>{model.family} · {model.label}</option>)}
                    </select>
                    <span className="settings-hint" style={{ marginTop: "0.4rem" }}>{matchingModelPresets.length} starter or provider-discovered model{matchingModelPresets.length === 1 ? "" : "s"} shown. Availability depends on the connected account; use Refresh or add an exact documented model ID.</span>
                  </div>
                  <div className="settings-row col" style={{ marginTop: "0.7rem" }}>
                    <label>Add custom model</label>
                    <div style={{ display: "flex", gap: "0.4rem" }}>
                      <input value={customModelDraft} onChange={(e) => setCustomModelDraft(e.target.value)} placeholder="Exact model ID from your provider" style={{ fontFamily: "var(--font-code)", fontSize: 11, flex: 1 }} onKeyDown={(e) => e.key === "Enter" && addCustomModel()}/>
                      <button className="btn btn-ghost" onClick={addCustomModel}>Add</button>
                    </div>
                  </div>
                  {providerInput === "compatible" && <div className="settings-row col" style={{ marginTop: "0.7rem" }}>
                      <label>Compatible HTTPS Base URL</label>
                      <input value={endpointInput} onChange={(e) => setEndpointInput(e.target.value)} placeholder="https://provider.example/v1" style={{ fontFamily: "var(--font-code)", fontSize: 11 }}/>
                      <span className="settings-hint" style={{ marginTop: "0.4rem" }}>Use this only for a documented OpenAI-compatible API. Headers are handled by SK Coder and cannot be pasted here.</span>
                    </div>}
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "0.75rem", marginTop: "0.8rem" }}>
                    <span style={{ fontSize: 12, color: keyStatus === "valid" ? "var(--green)" : ["invalid", "permission_denied"].includes(keyStatus) ? "var(--red)" : keyStatus === "none" ? "var(--text-muted)" : "var(--orange)" }}>
                      {keyStatus === "valid" ? "✓ Connected and verified" : keyStatus === "invalid" ? "✗ Provider rejected this key" : keyStatus === "permission_denied" ? "✗ Key does not have access to this model" : keyStatus === "credits_exhausted" ? "⚠ Credits or spend limit exhausted" : keyStatus === "rate_limited" ? "⚠ Provider rate limit is active" : keyStatus === "unreachable" ? "⚠ Provider could not be reached" : keyStatus === "provider_error" ? "⚠ Provider is temporarily unavailable" : keyStatus === "configuration_error" ? "⚠ Model or compatible endpoint needs attention" : checking ? "Checking real provider access..." : "Not connected"}
                    </span>
                    <button className="btn btn-primary" onClick={() => void handleConnectKey()} disabled={checking || !keyInput.trim()}>{checking ? "Checking..." : "Connect"}</button>
                  </div>
                  {connectionDetail && <div className="settings-hint" style={{ marginTop: "0.5rem", color: "var(--text-secondary)" }}>{connectionDetail}</div>}
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "0.5rem", marginTop: "0.6rem" }}>
                    <span className="settings-hint" style={{ margin: 0 }}>No API key is exported with project or connector settings.</span>
                    {!!settings.ai.apiKey && <button className="btn btn-ghost" onClick={handleClearApiKey} style={{ fontSize: 11, padding: "0.2rem 0.45rem" }}>Remove key</button>}
                  </div>
                </div>}

                <div className="settings-section">
                  <div className="settings-section-title">MCP and external tools</div>
                  <div className="settings-hint">MCP tools are available only through a reviewed workspace backend. SK Coder will not execute an unknown MCP link in the browser or send browser API keys or workspace files to an unreviewed endpoint. Approved tools must be installed by the workspace owner with explicit permissions and action review.</div>
                </div>
              </>)}

            {settingsTab === "github" && (<>
                <div className="settings-section">
                  <div className="settings-section-title">Personal Access Token</div>
                  <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: "0.75rem", lineHeight: 1.6 }}>
                    Use a fine-grained token when possible. Limit it to selected repositories and grant Contents read or write only as needed. Add Codespaces read or write only when you manage Codespaces.
                  </div>
                  {settings.github.username && (<div className="settings-key-status valid" style={{ marginBottom: "0.75rem" }}>
                      ✓ Connected as @{settings.github.username}
                    </div>)}
                  <div className="settings-row col">
                    <label>GitHub Token</label>
                    <div style={{ display: "flex", gap: "0.4rem", alignItems: "center", width: "100%" }}>
                      <input type={showToken ? "text" : "password"} value={tokenInput} onChange={(e) => setTokenInput(e.target.value)} placeholder="github_pat_... or ghp_..." style={{ fontFamily: "var(--font-code)", fontSize: 11, flex: 1 }}/>
                      <button className="btn btn-ghost" style={{ padding: "0.25rem 0.5rem", flexShrink: 0 }} onClick={() => setShowToken(!showToken)}>
                        {showToken ? "Hide" : "Show"}
                      </button>
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.75rem", flexWrap: "wrap" }}>
                    <button className="btn btn-primary" onClick={handleValidateToken}>Connect GitHub</button>
                    {!!settings.github.token && <button className="btn btn-ghost" onClick={handleDisconnectGitHub}>Disconnect</button>}
                    <a href="https://github.com/settings/personal-access-tokens/new?name=SK-Coder&description=Selected+repository+access" target="_blank" rel="noopener noreferrer" className="btn btn-secondary">
                      Create Token →
                    </a>
                  </div>
                  <div className="settings-hint">Your token stays in this browser’s local workspace state. It is sent to GitHub only when you choose a GitHub action, and Disconnect removes it here.</div>
                </div>
              </>)}

            {settingsTab === "about" && (<>
                <div className="settings-section">
                  <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", marginBottom: "1rem" }}>
                    <div style={{ width: 44, height: 44, borderRadius: 10, display: "grid", placeItems: "center", flexShrink: 0, background: "rgba(137, 180, 250, 0.16)", color: "var(--accent)" }}>
                      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <rect x="3" y="4" width="18" height="16" rx="3"/>
                        <path d="M8 8h8"/><path d="M8 12h8"/><path d="M8 16h5"/>
                      </svg>
                    </div>
                    <div>
                      <div style={{ fontWeight: 700, fontSize: 15, color: "var(--text-primary)" }}>SK Coder IDE</div>
                      <div style={{ fontSize: 11, color: "var(--text-muted)" }}>Version 3.0.0 — by Saqlain King</div>
                    </div>
                  </div>
                  <p style={{ fontSize: 12, color: "var(--text-secondary)", lineHeight: 1.7, marginBottom: "0.5rem" }}>
                    SK Coder is a mobile-first web IDE for writing, organizing, running, and reviewing code from one workspace.
                  </p>
                </div>

                <div className="settings-section">
                  <div className="settings-section-title">Help and policies</div>
                  <div style={{ fontSize: 12, color: "var(--text-secondary)", lineHeight: 1.7, marginBottom: "0.75rem" }}>Read the full guide, privacy policy, terms, and limits on their own simple page.</div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: "0.45rem" }}>
                    <a className="btn btn-primary" href="/guide" style={{ fontSize: 11, padding: "0.38rem 0.55rem", textDecoration: "none" }}>Open User Guide</a>
                    <a className="btn btn-ghost" href="/privacy" style={{ fontSize: 11, padding: "0.38rem 0.55rem", textDecoration: "none" }}>Privacy</a>
                    <a className="btn btn-ghost" href="/terms" style={{ fontSize: 11, padding: "0.38rem 0.55rem", textDecoration: "none" }}>Terms</a>
                  </div>
                </div>

                <div className="settings-section" style={{ borderBottom: "none" }}>
                  <div className="settings-section-title">Contact & Links</div>
                  <div style={{ display: "flex", alignItems: "center", gap: "1rem", padding: "0.75rem", background: "var(--bg-elevated)", borderRadius: "var(--radius)", marginBottom: "0.75rem" }}>
                    <img src={developerPortrait} alt="Saqlain King" style={{ width: 52, height: 52, borderRadius: "50%", objectFit: "cover", flexShrink: 0, border: "2px solid var(--border-focus)" }}/>
                    <div>
                      <div style={{ fontWeight: 700, fontSize: 13, color: "var(--text-primary)" }}>Saqlain King</div>
                      <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 2 }}>Developed by Saqlain King</div>
                      <div style={{ fontSize: 11, color: "var(--text-secondary)", marginTop: 3 }}>Building tools for developers everywhere.</div>
                    </div>
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
                    {[
                { label: "Report a Bug", href: "/feedback?type=bug", icon: "🐛" },
                { label: "Request a Feature", href: "/feedback?type=feature", icon: "💡" },
            ].map((link) => (<a key={link.label} href={link.href} style={{ display: "flex", alignItems: "center", gap: "0.5rem", fontSize: 12, color: "var(--accent)", textDecoration: "none", padding: "0.35rem 0" }}>
                        <span>{link.icon}</span>
                        <span>{link.label}</span>
                      </a>))}
                  </div>
                </div>
              </>)}

          </div>
        </div>
      </div>
    </div>);
}
