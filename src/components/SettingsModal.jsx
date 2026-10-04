import { useEffect, useState } from 'react';
import { X, KeyRound, Bot, Code2, Palette, Info, Eye, EyeOff, CircleCheck, Loader2, RefreshCw } from 'lucide-react';
import { useStore } from '../lib/store';
import { api } from '../lib/api';
import Logo from './Logo.jsx';

const SECTIONS = [
  { id: 'models', label: 'Models & Keys', icon: KeyRound },
  { id: 'agent', label: 'Agent', icon: Bot },
  { id: 'editor', label: 'Editor', icon: Code2 },
  { id: 'appearance', label: 'Appearance', icon: Palette },
  { id: 'about', label: 'About', icon: Info },
];

export default function SettingsModal() {
  const arg = useStore((s) => s.overlayArg);
  const close = useStore((s) => s.closeOverlay);
  const [section, setSection] = useState(arg && SECTIONS.find((s) => s.id === arg) ? arg : 'models');

  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && close();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="modal settings">
        <div className="modal-head">
          <span className="spacer">Settings</span>
          <button className="icon-btn" onClick={close}>
            <X size={16} />
          </button>
        </div>
        <div className="settings-layout">
          <div className="settings-nav">
            {SECTIONS.map(({ id, label, icon: Icon }) => (
              <button key={id} className={section === id ? 'active' : ''} onClick={() => setSection(id)}>
                <Icon size={15} /> {label}
              </button>
            ))}
          </div>
          <div className="settings-content">
            {section === 'models' && <ModelsSection />}
            {section === 'agent' && <AgentSection />}
            {section === 'editor' && <EditorSection />}
            {section === 'appearance' && <AppearanceSection />}
            {section === 'about' && <AboutSection />}
          </div>
        </div>
      </div>
    </div>
  );
}

function cleanError(msg) {
  return String(msg || '').replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}

function ProviderCard({ provider, name, color, letter, link, linkLabel, help, placeholder }) {
  const keys = useStore((s) => s.keys);
  const info = keys[provider] || {};
  const [value, setValue] = useState('');
  const [show, setShow] = useState(false);
  const [test, setTest] = useState(null); // { busy } | { ok, count } | { error }
  const st = useStore.getState;

  const save = async () => {
    if (!value.trim()) return;
    setTest({ busy: true });
    const saved = await api.setKey(provider, value);
    await st().refreshKeys();
    setValue('');
    const r = await api.testKey(provider);
    setTest(r.ok ? { ok: true, count: r.count, warning: saved.warning } : { error: r.error, warning: saved.warning });
    if (r.ok) st().refreshModels(provider, true);
  };
  const runTest = async () => {
    setTest({ busy: true });
    const r = await api.testKey(provider, value || undefined);
    setTest(r.ok ? { ok: true, count: r.count, warning: r.warning } : { error: r.error, warning: r.warning });
  };
  const remove = async () => {
    await api.setKey(provider, '');
    await st().refreshKeys();
    setTest(null);
    st().refreshModels(provider, true);
  };

  return (
    <div className="provider-card">
      <div className="head">
        <div className="provider-logo" style={{ background: color }}>
          {letter}
        </div>
        <div className="spacer">
          <div className="pname">{name}</div>
          {info.set ? (
            <span className="status-ok">
              <CircleCheck size={12} /> Key saved <span className="mono faint">{info.masked}</span>
            </span>
          ) : (
            <span className="faint" style={{ fontSize: 12 }}>
              No key
            </span>
          )}
        </div>
        {info.set && (
          <>
            <button className="btn sm" onClick={runTest}>
              Test
            </button>
            <button className="btn sm ghost" onClick={remove}>
              Remove
            </button>
          </>
        )}
      </div>
      <div className="field-row">
        <div style={{ position: 'relative', flex: 1 }}>
          <input
            className="input mono"
            type={show ? 'text' : 'password'}
            placeholder={info.set ? 'Paste a new key to replace the saved one' : placeholder}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && save()}
            spellCheck={false}
            autoComplete="off"
            style={{ paddingRight: 30 }}
          />
          <button className="icon-btn sm" style={{ position: 'absolute', right: 3, top: 3 }} onClick={() => setShow((v) => !v)} title={show ? 'Hide' : 'Show'}>
            {show ? <EyeOff size={13} /> : <Eye size={13} />}
          </button>
        </div>
        <button className="btn primary" disabled={!value.trim()} onClick={save}>
          Save
        </button>
      </div>
      <div className="field">
        <div className="help">
          {help}{' '}
          <a onClick={() => api.openExternal(link)}>{linkLabel}</a>
        </div>
        {test?.busy && (
          <div className="help row">
            <Loader2 size={12} className="spin" /> Checking key…
          </div>
        )}
        {test?.ok && <div className="help status-ok">✓ Key works — {test.count} models available.</div>}
        {test?.error && <div className="help status-bad">✗ {cleanError(test.error)}</div>}
        {test?.warning && <div className="help status-warn">{test.warning}</div>}
      </div>
    </div>
  );
}

function ModelSelect({ value, onChange, includeAll = true }) {
  const models = useStore((s) => s.models);
  const keys = useStore((s) => s.keys);
  const v = value ? `${value.provider}::${value.model}` : '';
  const known = ['google', 'groq'].some((p) => models[p]?.some((m) => m.id === value?.model));
  return (
    <select
      className="input"
      value={v}
      onChange={(e) => {
        const [provider, ...rest] = e.target.value.split('::');
        onChange({ provider, model: rest.join('::') });
      }}
    >
      {!known && value && <option value={v}>{value.model}</option>}
      {['google', 'groq'].map((p) => (
        <optgroup key={p} label={`${p === 'google' ? 'Google Gemini' : 'Groq'}${keys[p]?.set ? '' : ' (no key)'}`}>
          {(models[p] || []).map((m) => (
            <option key={m.id} value={`${p}::${m.id}`}>
              {m.label || m.id}
              {m.label && m.label !== m.id ? `  —  ${m.id}` : ''}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}

function ModelsSection() {
  const settings = useStore((s) => s.settings);
  const errors = useStore((s) => s.modelErrors);
  const update = useStore((s) => s.updateSettings);
  const [refreshing, setRefreshing] = useState(false);
  return (
    <>
      <h2>Models & API Keys</h2>
      <p className="desc">Pointer talks directly to Google and Groq with your own keys. Keys are encrypted with your operating system's secure storage and never leave this machine except to call the provider.</p>
      <ProviderCard
        provider="google"
        name="Google Gemini"
        letter="G"
        color="linear-gradient(135deg,#4285f4,#9b72cb 60%,#d96570)"
        placeholder="AQ.… or AIza…"
        link="https://aistudio.google.com/apikey"
        linkLabel="Get a key in Google AI Studio →"
        help={
          <>
            New Google AI Studio keys start with <code>AQ.</code> (“Auth keys”) — paste the whole key, including the dot. Pointer sends it in the <code>x-goog-api-key</code> header, which these keys require. Older <code>AIza…</code> keys work too.
          </>
        }
      />
      <ProviderCard
        provider="groq"
        name="Groq"
        letter="⚡"
        color="linear-gradient(135deg,#f55036,#ff8a4c)"
        placeholder="gsk_…"
        link="https://console.groq.com/keys"
        linkLabel="Get a key in the Groq console →"
        help={<>Groq runs open models (GPT-OSS, …) extremely fast — great for the agent and for Tab autocomplete. Keys start with <code>gsk_</code>.</>}
      />

      <div className="row" style={{ margin: '22px 0 10px' }}>
        <h2 style={{ margin: 0 }} className="spacer">
          Default models
        </h2>
        <button
          className="btn sm"
          onClick={async () => {
            setRefreshing(true);
            await useStore.getState().refreshModels(null, true);
            setRefreshing(false);
          }}
        >
          <RefreshCw size={12} className={refreshing ? 'spin' : ''} /> Refresh lists
        </button>
      </div>
      {(errors.google || errors.groq) && (
        <div className="warning-box">
          <div>
            {errors.google && <div>Google: {cleanError(errors.google)}</div>}
            {errors.groq && <div>Groq: {cleanError(errors.groq)}</div>}
          </div>
        </div>
      )}
      <div className="field">
        <label>Agent & chat</label>
        <ModelSelect value={settings.chatModel} onChange={(v) => update({ chatModel: v })} />
        <div className="help">Used by the AI pane. You can also switch it from the model menu under the chat box.</div>
      </div>
      <div className="field">
        <label>Inline edit (Ctrl+K)</label>
        <ModelSelect value={settings.inlineModel} onChange={(v) => update({ inlineModel: v })} />
      </div>
      <div className="toggle-row">
        <div className="txt">
          <div className="t">Tab autocomplete</div>
          <div className="d">Ghost-text suggestions while you type. Press Tab to accept.</div>
        </div>
        <button className={`switch ${settings.autocompleteEnabled ? 'on' : ''}`} onClick={() => update({ autocompleteEnabled: !settings.autocompleteEnabled })} />
      </div>
      <div className="field">
        <label>Autocomplete model</label>
        <ModelSelect value={settings.autocompleteModel} onChange={(v) => update({ autocompleteModel: v })} />
        <div className="help">Pick a fast model — Groq's GPT-OSS 20B or Gemini Flash-Lite work well.</div>
      </div>
    </>
  );
}

function NumberField({ label, value, onChange, min, max, help }) {
  const [v, setV] = useState(String(value));
  useEffect(() => setV(String(value)), [value]);
  return (
    <div className="field">
      <label>{label}</label>
      <input
        className="input"
        type="number"
        style={{ width: 120 }}
        value={v}
        min={min}
        max={max}
        onChange={(e) => setV(e.target.value)}
        onBlur={() => {
          const n = Math.min(max, Math.max(min, Number(v) || min));
          setV(String(n));
          if (n !== value) onChange(n);
        }}
      />
      {help && <div className="help">{help}</div>}
    </div>
  );
}

function AgentSection() {
  const settings = useStore((s) => s.settings);
  const update = useStore((s) => s.updateSettings);
  const [instr, setInstr] = useState(settings.customInstructions || '');
  return (
    <>
      <h2>Agent</h2>
      <p className="desc">The agent runs on your real machine — it reads and writes files and executes commands in your shell, with no sandbox.</p>
      <div className="field">
        <label>Command approval</label>
        <div className="seg">
          <button className={settings.autoRun !== 'auto' ? 'on' : ''} onClick={() => update({ autoRun: 'ask' })}>
            Ask before running commands
          </button>
          <button className={settings.autoRun === 'auto' ? 'on' : ''} onClick={() => update({ autoRun: 'auto' })}>
            Auto-run everything
          </button>
        </div>
        <div className="help">
          {settings.autoRun === 'auto'
            ? 'Full autonomy: terminal commands and deletions run immediately without confirmation.'
            : 'File edits are applied immediately (and can be undone). Terminal commands and deletions wait for your approval.'}
        </div>
      </div>
      <NumberField label="Max steps per request" value={settings.maxSteps} min={5} max={500} onChange={(n) => update({ maxSteps: n })} help="How many model turns (tool rounds) the agent may take before pausing." />
      <NumberField label="Command timeout (seconds)" value={settings.commandTimeout} min={10} max={3600} onChange={(n) => update({ commandTimeout: n })} help="Foreground commands are stopped after this long. Servers should be started in the background." />
      <div className="field">
        <label>Custom instructions</label>
        <textarea className="input" rows={6} value={instr} onChange={(e) => setInstr(e.target.value)} onBlur={() => update({ customInstructions: instr })} placeholder="e.g. Always use TypeScript. Prefer pnpm. Write tests with Vitest." />
        <div className="help">
          Added to every request. Pointer also reads <code>.pointerrules</code>, <code>.cursorrules</code> and <code>AGENTS.md</code> from the open folder.
        </div>
      </div>
    </>
  );
}

function EditorSection() {
  const settings = useStore((s) => s.settings);
  const update = useStore((s) => s.updateSettings);
  const e = settings.editor;
  const toggle = (k, title, d) => (
    <div className="toggle-row">
      <div className="txt">
        <div className="t">{title}</div>
        {d && <div className="d">{d}</div>}
      </div>
      <button className={`switch ${e[k] ? 'on' : ''}`} onClick={() => update({ editor: { [k]: !e[k] } })} />
    </div>
  );
  return (
    <>
      <h2>Editor</h2>
      <p className="desc">Monaco — the editor that powers VS Code.</p>
      <NumberField label="Font size" value={e.fontSize} min={8} max={32} onChange={(n) => update({ editor: { fontSize: n } })} />
      <NumberField label="Tab size" value={e.tabSize} min={1} max={8} onChange={(n) => update({ editor: { tabSize: n } })} />
      <div className="field">
        <label>Font family</label>
        <input className="input mono" defaultValue={e.fontFamily} onBlur={(ev) => update({ editor: { fontFamily: ev.target.value } })} />
      </div>
      <div className="field">
        <label>Word wrap</label>
        <div className="seg">
          <button className={e.wordWrap !== 'on' ? 'on' : ''} onClick={() => update({ editor: { wordWrap: 'off' } })}>
            Off
          </button>
          <button className={e.wordWrap === 'on' ? 'on' : ''} onClick={() => update({ editor: { wordWrap: 'on' } })}>
            On
          </button>
        </div>
      </div>
      {toggle('minimap', 'Minimap')}
      {toggle('autoSave', 'Auto save', 'Save files automatically one second after you stop typing.')}
      {toggle('formatOnSave', 'Format on save', 'Uses the built-in formatter for JS/TS/JSON/CSS/HTML.')}
      <NumberField label="Terminal font size" value={settings.terminal.fontSize} min={8} max={28} onChange={(n) => update({ terminal: { fontSize: n } })} />
    </>
  );
}

function AppearanceSection() {
  const settings = useStore((s) => s.settings);
  const update = useStore((s) => s.updateSettings);
  return (
    <>
      <h2>Appearance</h2>
      <p className="desc">Choose how Pointer looks.</p>
      <div className="field">
        <label>Theme</label>
        <div className="seg">
          <button className={settings.theme !== 'light' ? 'on' : ''} onClick={() => update({ theme: 'dark' })}>
            Dark
          </button>
          <button className={settings.theme === 'light' ? 'on' : ''} onClick={() => update({ theme: 'light' })}>
            Light
          </button>
        </div>
      </div>
    </>
  );
}

function AboutSection() {
  const info = useStore((s) => s.info);
  return (
    <>
      <div className="row" style={{ gap: 12, marginBottom: 14 }}>
        <Logo size={42} />
        <div>
          <h2 style={{ margin: 0 }}>Pointer</h2>
          <div className="muted">Version {info?.version}</div>
        </div>
      </div>
      <p className="desc">An AI-first code editor with a real coding agent, powered by Google Gemini and Groq.</p>
      <div className="shortcut-grid" style={{ marginBottom: 16 }}>
        <span>Electron</span>
        <span className="mono">{info?.electron}</span>
        <span>Platform</span>
        <span className="mono">
          {info?.platform} {info?.arch}
        </span>
        <span>Data folder</span>
        <span className="mono" style={{ userSelect: 'text' }}>
          {info?.userData}
        </span>
      </div>
      <button className="btn" onClick={() => api.openPath(info?.userData)}>
        Open data folder
      </button>
    </>
  );
}
