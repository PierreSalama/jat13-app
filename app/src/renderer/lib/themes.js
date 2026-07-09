// JAT v11 — theme registry (ES module, shared by both dashboard hosts).
// 53 built-in themes. Each theme defines the 11 CSS custom properties applied
// to the entire app via inline vars on <html> and data-theme="<id>" on <body>.
// All themes provide: bg, bg2, panel, border, text, muted, primary, primary2,
// success, warn, danger.
//
// 'atelier' (first entry, default) is a direct adaptation of the Ayhan's
// Barbershop look (black/gold/bone) by Pierre & Mina — same palette + same
// methodology as the v10 dashboard: square corners, eyebrow labels, hairline
// rules, gold accents, ambient radial glow.
// The remaining 52 themes are ported verbatim from v9 lib/themes.js.
export const THEMES = [
  { id: 'atelier', name: 'Atelier', icon: '🖋️', mode: 'dark', vars: { bg: '#0a0a0a', bg2: '#141414', panel: '#1c1a18', border: '#3a342d', text: '#f4efe6', muted: '#8b8378', primary: '#b08a5a', primary2: '#c9a373', success: '#88b08a', warn: '#c9a373', danger: '#c97070' } },

  // ========== Dark themes ==========
  { id: 'midnight', name: 'Midnight', icon: '🌙', mode: 'dark', vars: { bg: '#0f172a', bg2: '#1e293b', panel: '#1e293b', border: 'rgba(255,255,255,0.08)', text: '#f8fafc', muted: '#94a3b8', primary: '#6366f1', primary2: '#8b5cf6', success: '#10b981', warn: '#f59e0b', danger: '#ef4444' } },
  { id: 'oceanic', name: 'Oceanic', icon: '🌊', mode: 'dark', vars: { bg: '#0a192f', bg2: '#112a45', panel: '#112a45', border: 'rgba(100,255,218,0.12)', text: '#ccd6f6', muted: '#8892b0', primary: '#64ffda', primary2: '#00bfa5', success: '#69f0ae', warn: '#ffab00', danger: '#ff5252' } },
  { id: 'cyberpunk', name: 'Cyberpunk', icon: '🤖', mode: 'dark', vars: { bg: '#0a001a', bg2: '#180033', panel: '#180033', border: 'rgba(255,0,255,0.18)', text: '#fff5ff', muted: '#b48fff', primary: '#ff007f', primary2: '#00f0ff', success: '#7cffb5', warn: '#ffe600', danger: '#ff3838' } },
  { id: 'forest', name: 'Forest', icon: '🌲', mode: 'dark', vars: { bg: '#0a1f0a', bg2: '#13301a', panel: '#13301a', border: 'rgba(74,222,128,0.18)', text: '#e6f4ea', muted: '#8db89a', primary: '#4ade80', primary2: '#22c55e', success: '#4ade80', warn: '#fcd34d', danger: '#f87171' } },
  { id: 'rosegold', name: 'Rose Gold', icon: '🌹', mode: 'dark', vars: { bg: '#1c0e15', bg2: '#2a1820', panel: '#2a1820', border: 'rgba(251,191,165,0.18)', text: '#fce7e0', muted: '#c8a59c', primary: '#fbbfa5', primary2: '#fb7185', success: '#86efac', warn: '#fcd34d', danger: '#fb7185' } },
  { id: 'monokai', name: 'Monokai', icon: '🎨', mode: 'dark', vars: { bg: '#272822', bg2: '#3e3d32', panel: '#3e3d32', border: 'rgba(249,38,114,0.2)', text: '#f8f8f2', muted: '#75715e', primary: '#a6e22e', primary2: '#f92672', success: '#a6e22e', warn: '#e6db74', danger: '#f92672' } },
  { id: 'dracula', name: 'Dracula', icon: '🧛', mode: 'dark', vars: { bg: '#282a36', bg2: '#44475a', panel: '#44475a', border: 'rgba(189,147,249,0.2)', text: '#f8f8f2', muted: '#6272a4', primary: '#bd93f9', primary2: '#ff79c6', success: '#50fa7b', warn: '#f1fa8c', danger: '#ff5555' } },
  { id: 'nord', name: 'Nord', icon: '❄️', mode: 'dark', vars: { bg: '#2e3440', bg2: '#3b4252', panel: '#3b4252', border: 'rgba(136,192,208,0.2)', text: '#eceff4', muted: '#81a1c1', primary: '#88c0d0', primary2: '#5e81ac', success: '#a3be8c', warn: '#ebcb8b', danger: '#bf616a' } },
  { id: 'gruvbox', name: 'Gruvbox', icon: '🍂', mode: 'dark', vars: { bg: '#282828', bg2: '#3c3836', panel: '#3c3836', border: 'rgba(254,128,25,0.2)', text: '#ebdbb2', muted: '#a89984', primary: '#fe8019', primary2: '#d3869b', success: '#b8bb26', warn: '#fabd2f', danger: '#fb4934' } },
  { id: 'amber', name: 'Amber Terminal', icon: '🟧', mode: 'dark', vars: { bg: '#0d0700', bg2: '#1a0e00', panel: '#1a0e00', border: 'rgba(255,176,0,0.25)', text: '#ffb000', muted: '#aa7700', primary: '#ffb000', primary2: '#ff7700', success: '#aaff00', warn: '#ffaa00', danger: '#ff3333' } },
  { id: 'crimson', name: 'Crimson Night', icon: '🩸', mode: 'dark', vars: { bg: '#1a0808', bg2: '#2b0e10', panel: '#2b0e10', border: 'rgba(239,68,68,0.18)', text: '#fef2f2', muted: '#a78c8c', primary: '#ef4444', primary2: '#f97316', success: '#22c55e', warn: '#f59e0b', danger: '#ef4444' } },
  { id: 'galactic', name: 'Galactic', icon: '🌌', mode: 'dark', vars: { bg: '#0b0628', bg2: '#160d3d', panel: '#160d3d', border: 'rgba(192,132,252,0.2)', text: '#f5f3ff', muted: '#8b8aa3', primary: '#a78bfa', primary2: '#ec4899', success: '#86efac', warn: '#fcd34d', danger: '#f87171' } },
  { id: 'matcha', name: 'Matcha', icon: '🍵', mode: 'dark', vars: { bg: '#0f1c12', bg2: '#1a2f1f', panel: '#1a2f1f', border: 'rgba(132,204,22,0.2)', text: '#f0fdf4', muted: '#86b08c', primary: '#84cc16', primary2: '#22c55e', success: '#bef264', warn: '#fde047', danger: '#f87171' } },

  // ========== Light themes ==========
  { id: 'arctic', name: 'Arctic', icon: '☃️', mode: 'light', vars: { bg: '#f8fafc', bg2: '#ffffff', panel: '#ffffff', border: 'rgba(15,23,42,0.08)', text: '#0f172a', muted: '#64748b', primary: '#0ea5e9', primary2: '#6366f1', success: '#10b981', warn: '#f59e0b', danger: '#ef4444' } },
  { id: 'paper', name: 'Paper', icon: '📄', mode: 'light', vars: { bg: '#fafaf7', bg2: '#ffffff', panel: '#ffffff', border: 'rgba(0,0,0,0.08)', text: '#1c1917', muted: '#78716c', primary: '#0f766e', primary2: '#0e7490', success: '#16a34a', warn: '#d97706', danger: '#dc2626' } },
  { id: 'solarized', name: 'Solarized Light', icon: '☀️', mode: 'light', vars: { bg: '#fdf6e3', bg2: '#eee8d5', panel: '#eee8d5', border: 'rgba(101,123,131,0.2)', text: '#073642', muted: '#586e75', primary: '#268bd2', primary2: '#6c71c4', success: '#859900', warn: '#b58900', danger: '#dc322f' } },
  { id: 'sakura', name: 'Sakura', icon: '🌸', mode: 'light', vars: { bg: '#fff1f2', bg2: '#ffffff', panel: '#ffffff', border: 'rgba(244,114,182,0.18)', text: '#831843', muted: '#9d4d6f', primary: '#ec4899', primary2: '#f472b6', success: '#10b981', warn: '#f59e0b', danger: '#dc2626' } },
  { id: 'mint', name: 'Mint', icon: '🌿', mode: 'light', vars: { bg: '#f0fdf4', bg2: '#ffffff', panel: '#ffffff', border: 'rgba(34,197,94,0.18)', text: '#14532d', muted: '#52796f', primary: '#22c55e', primary2: '#10b981', success: '#15803d', warn: '#ca8a04', danger: '#dc2626' } },
  { id: 'sunset', name: 'Sunset', icon: '🌅', mode: 'light', vars: { bg: '#fff7ed', bg2: '#ffffff', panel: '#ffffff', border: 'rgba(249,115,22,0.18)', text: '#7c2d12', muted: '#9a644a', primary: '#f97316', primary2: '#dc2626', success: '#16a34a', warn: '#ca8a04', danger: '#dc2626' } },
  { id: 'lavender', name: 'Lavender', icon: '💜', mode: 'light', vars: { bg: '#faf5ff', bg2: '#ffffff', panel: '#ffffff', border: 'rgba(168,85,247,0.18)', text: '#4c1d95', muted: '#8b7aa6', primary: '#a855f7', primary2: '#7c3aed', success: '#16a34a', warn: '#ca8a04', danger: '#dc2626' } },
  { id: 'graphite', name: 'Graphite', icon: '✏️', mode: 'light', vars: { bg: '#f3f4f6', bg2: '#ffffff', panel: '#ffffff', border: 'rgba(0,0,0,0.1)', text: '#111827', muted: '#6b7280', primary: '#374151', primary2: '#1f2937', success: '#059669', warn: '#d97706', danger: '#dc2626' } },
  { id: 'slate', name: 'Slate Pro', icon: '🪨', mode: 'light', vars: { bg: '#f8fafc', bg2: '#ffffff', panel: '#ffffff', border: 'rgba(15,23,42,0.1)', text: '#0f172a', muted: '#475569', primary: '#475569', primary2: '#1e293b', success: '#15803d', warn: '#a16207', danger: '#b91c1c' } },

  // ========== Additional dark themes ==========
  { id: 'tokyo-night', name: 'Tokyo Night', icon: '🗼', mode: 'dark', vars: { bg: '#1a1b26', bg2: '#24283b', panel: '#24283b', border: 'rgba(125,207,255,0.15)', text: '#c0caf5', muted: '#565f89', primary: '#7dcfff', primary2: '#bb9af7', success: '#9ece6a', warn: '#e0af68', danger: '#f7768e' } },
  { id: 'one-dark', name: 'One Dark', icon: '⚛️', mode: 'dark', vars: { bg: '#282c34', bg2: '#3a3f4b', panel: '#3a3f4b', border: 'rgba(97,175,239,0.2)', text: '#abb2bf', muted: '#5c6370', primary: '#61afef', primary2: '#c678dd', success: '#98c379', warn: '#e5c07b', danger: '#e06c75' } },
  { id: 'catppuccin-mocha', name: 'Catppuccin Mocha', icon: '☕', mode: 'dark', vars: { bg: '#1e1e2e', bg2: '#313244', panel: '#313244', border: 'rgba(203,166,247,0.18)', text: '#cdd6f4', muted: '#a6adc8', primary: '#cba6f7', primary2: '#f5c2e7', success: '#a6e3a1', warn: '#f9e2af', danger: '#f38ba8' } },
  { id: 'catppuccin-macchiato', name: 'Catppuccin Macchiato', icon: '🍮', mode: 'dark', vars: { bg: '#24273a', bg2: '#363a4f', panel: '#363a4f', border: 'rgba(198,160,246,0.18)', text: '#cad3f5', muted: '#a5adcb', primary: '#c6a0f6', primary2: '#f5bde6', success: '#a6da95', warn: '#eed49f', danger: '#ed8796' } },
  { id: 'palenight', name: 'Palenight', icon: '🌃', mode: 'dark', vars: { bg: '#292d3e', bg2: '#3a3f58', panel: '#3a3f58', border: 'rgba(199,146,234,0.18)', text: '#a6accd', muted: '#676e95', primary: '#c792ea', primary2: '#82aaff', success: '#c3e88d', warn: '#ffcb6b', danger: '#f07178' } },
  { id: 'github-dark', name: 'GitHub Dark', icon: '🐙', mode: 'dark', vars: { bg: '#0d1117', bg2: '#161b22', panel: '#161b22', border: 'rgba(240,246,252,0.1)', text: '#c9d1d9', muted: '#8b949e', primary: '#58a6ff', primary2: '#bc8cff', success: '#3fb950', warn: '#d29922', danger: '#f85149' } },
  { id: 'github-dimmed', name: 'GitHub Dimmed', icon: '🌑', mode: 'dark', vars: { bg: '#22272e', bg2: '#2d333b', panel: '#2d333b', border: 'rgba(205,217,229,0.1)', text: '#adbac7', muted: '#768390', primary: '#539bf5', primary2: '#b083f0', success: '#57ab5a', warn: '#c69026', danger: '#e5534b' } },
  { id: 'vscode-dark', name: 'VS Code Dark', icon: '🟦', mode: 'dark', vars: { bg: '#1e1e1e', bg2: '#252526', panel: '#252526', border: 'rgba(255,255,255,0.08)', text: '#d4d4d4', muted: '#858585', primary: '#007acc', primary2: '#569cd6', success: '#4ec9b0', warn: '#dcdcaa', danger: '#f44747' } },
  { id: 'material-dark', name: 'Material Dark', icon: '🧱', mode: 'dark', vars: { bg: '#212121', bg2: '#303030', panel: '#303030', border: 'rgba(255,255,255,0.1)', text: '#eeffff', muted: '#b0bec5', primary: '#80cbc4', primary2: '#82b1ff', success: '#c3e88d', warn: '#ffcb6b', danger: '#ff5370' } },
  { id: 'nightfall', name: 'Nightfall', icon: '🌌', mode: 'dark', vars: { bg: '#0c0e1a', bg2: '#171a2c', panel: '#171a2c', border: 'rgba(99,102,241,0.18)', text: '#e2e8f0', muted: '#6b7299', primary: '#6366f1', primary2: '#3b82f6', success: '#34d399', warn: '#fbbf24', danger: '#f87171' } },
  { id: 'deep-space', name: 'Deep Space', icon: '🪐', mode: 'dark', vars: { bg: '#05060d', bg2: '#0d1024', panel: '#0d1024', border: 'rgba(56,189,248,0.15)', text: '#e0e7ff', muted: '#7c83a8', primary: '#38bdf8', primary2: '#a78bfa', success: '#4ade80', warn: '#facc15', danger: '#fb7185' } },
  { id: 'neon', name: 'Neon Pulse', icon: '💫', mode: 'dark', vars: { bg: '#0a0a14', bg2: '#14142b', panel: '#14142b', border: 'rgba(34,211,238,0.25)', text: '#f0fdff', muted: '#7e8aa6', primary: '#22d3ee', primary2: '#d946ef', success: '#22c55e', warn: '#facc15', danger: '#f43f5e' } },
  { id: 'vaporwave', name: 'Vaporwave', icon: '🌴', mode: 'dark', vars: { bg: '#1a0033', bg2: '#2d0a4e', panel: '#2d0a4e', border: 'rgba(255,113,206,0.22)', text: '#fff1ff', muted: '#b48ad9', primary: '#ff71ce', primary2: '#01cdfe', success: '#05ffa1', warn: '#fffb96', danger: '#ff6ec7' } },
  { id: 'retro-terminal', name: 'Retro Terminal', icon: '🖥️', mode: 'dark', vars: { bg: '#001100', bg2: '#002200', panel: '#002200', border: 'rgba(0,255,0,0.25)', text: '#00ff66', muted: '#00aa44', primary: '#00ff66', primary2: '#33ff99', success: '#88ff88', warn: '#ffff00', danger: '#ff5555' } },
  { id: 'midnight-purple', name: 'Midnight Purple', icon: '🟣', mode: 'dark', vars: { bg: '#150529', bg2: '#240a45', panel: '#240a45', border: 'rgba(168,85,247,0.2)', text: '#f3e8ff', muted: '#a78bd9', primary: '#a855f7', primary2: '#d946ef', success: '#4ade80', warn: '#facc15', danger: '#f87171' } },
  { id: 'espresso', name: 'Espresso', icon: '☕', mode: 'dark', vars: { bg: '#1b110b', bg2: '#2b1d14', panel: '#2b1d14', border: 'rgba(217,164,107,0.2)', text: '#f5e6d3', muted: '#a8896b', primary: '#d9a46b', primary2: '#c97f4e', success: '#94c973', warn: '#e8c547', danger: '#e57373' } },
  { id: 'cherry', name: 'Cherry', icon: '🍒', mode: 'dark', vars: { bg: '#1a0612', bg2: '#2c0a1f', panel: '#2c0a1f', border: 'rgba(244,63,94,0.2)', text: '#fff0f5', muted: '#c08aa0', primary: '#f43f5e', primary2: '#ec4899', success: '#86efac', warn: '#fcd34d', danger: '#ef4444' } },
  { id: 'midnight-blue', name: 'Midnight Blue', icon: '🔵', mode: 'dark', vars: { bg: '#0a0e27', bg2: '#141a3d', panel: '#141a3d', border: 'rgba(59,130,246,0.18)', text: '#dbeafe', muted: '#6b7faa', primary: '#3b82f6', primary2: '#1d4ed8', success: '#22c55e', warn: '#eab308', danger: '#ef4444' } },
  { id: 'emerald-dark', name: 'Emerald', icon: '💚', mode: 'dark', vars: { bg: '#022c22', bg2: '#064e3b', panel: '#064e3b', border: 'rgba(52,211,153,0.2)', text: '#d1fae5', muted: '#6ee7b7', primary: '#34d399', primary2: '#10b981', success: '#4ade80', warn: '#fde047', danger: '#fb7185' } },
  { id: 'ruby', name: 'Ruby', icon: '💎', mode: 'dark', vars: { bg: '#1f0610', bg2: '#3b0a1e', panel: '#3b0a1e', border: 'rgba(225,29,72,0.22)', text: '#ffe4ec', muted: '#c89aa9', primary: '#e11d48', primary2: '#be123c', success: '#86efac', warn: '#fcd34d', danger: '#f43f5e' } },

  // ========== Additional light themes ==========
  { id: 'github-light', name: 'GitHub Light', icon: '🐱', mode: 'light', vars: { bg: '#ffffff', bg2: '#f6f8fa', panel: '#f6f8fa', border: 'rgba(31,35,40,0.15)', text: '#1f2328', muted: '#656d76', primary: '#0969da', primary2: '#8250df', success: '#1a7f37', warn: '#9a6700', danger: '#cf222e' } },
  { id: 'atom-one-light', name: 'Atom One Light', icon: '⚛️', mode: 'light', vars: { bg: '#fafafa', bg2: '#ffffff', panel: '#ffffff', border: 'rgba(56,58,66,0.12)', text: '#383a42', muted: '#a0a1a7', primary: '#4078f2', primary2: '#a626a4', success: '#50a14f', warn: '#c18401', danger: '#e45649' } },
  { id: 'vscode-light', name: 'VS Code Light', icon: '🟦', mode: 'light', vars: { bg: '#ffffff', bg2: '#f3f3f3', panel: '#f3f3f3', border: 'rgba(0,0,0,0.1)', text: '#1e1e1e', muted: '#6c6c6c', primary: '#0066b8', primary2: '#7b1fa2', success: '#098658', warn: '#bf8803', danger: '#d13438' } },
  { id: 'catppuccin-latte', name: 'Catppuccin Latte', icon: '🥛', mode: 'light', vars: { bg: '#eff1f5', bg2: '#e6e9ef', panel: '#e6e9ef', border: 'rgba(136,57,239,0.18)', text: '#4c4f69', muted: '#6c6f85', primary: '#8839ef', primary2: '#ea76cb', success: '#40a02b', warn: '#df8e1d', danger: '#d20f39' } },
  { id: 'material-light', name: 'Material Light', icon: '🧱', mode: 'light', vars: { bg: '#fafafa', bg2: '#ffffff', panel: '#ffffff', border: 'rgba(0,0,0,0.1)', text: '#212121', muted: '#757575', primary: '#1976d2', primary2: '#7b1fa2', success: '#388e3c', warn: '#f57c00', danger: '#d32f2f' } },
  { id: 'candy', name: 'Candy', icon: '🍬', mode: 'light', vars: { bg: '#fff5fb', bg2: '#ffffff', panel: '#ffffff', border: 'rgba(236,72,153,0.18)', text: '#581c47', muted: '#a06484', primary: '#ec4899', primary2: '#a855f7', success: '#22c55e', warn: '#f59e0b', danger: '#ef4444' } },
  { id: 'autumn', name: 'Autumn', icon: '🍁', mode: 'light', vars: { bg: '#fdf4e3', bg2: '#ffffff', panel: '#ffffff', border: 'rgba(180,83,9,0.18)', text: '#582c0e', muted: '#92654a', primary: '#b45309', primary2: '#dc2626', success: '#65a30d', warn: '#ca8a04', danger: '#b91c1c' } },
  { id: 'beach', name: 'Beach', icon: '🏖️', mode: 'light', vars: { bg: '#f0fbff', bg2: '#ffffff', panel: '#ffffff', border: 'rgba(14,165,233,0.18)', text: '#0c4a6e', muted: '#5a8aa6', primary: '#0ea5e9', primary2: '#06b6d4', success: '#16a34a', warn: '#eab308', danger: '#dc2626' } },
  { id: 'tangerine', name: 'Tangerine', icon: '🍊', mode: 'light', vars: { bg: '#fff8f0', bg2: '#ffffff', panel: '#ffffff', border: 'rgba(234,88,12,0.2)', text: '#7c2d12', muted: '#a87356', primary: '#ea580c', primary2: '#f97316', success: '#16a34a', warn: '#ca8a04', danger: '#dc2626' } },
  { id: 'blueprint', name: 'Blueprint', icon: '📐', mode: 'light', vars: { bg: '#eef4fb', bg2: '#ffffff', panel: '#ffffff', border: 'rgba(30,64,175,0.2)', text: '#1e3a8a', muted: '#5b7bb1', primary: '#1e40af', primary2: '#2563eb', success: '#15803d', warn: '#a16207', danger: '#b91c1c' } },
];

export const DEFAULT_THEME = 'atelier';

export function getTheme(id) {
  return THEMES.find((t) => t.id === id) || THEMES[0];
}

// Applies the 11 CSS vars to <html> and stamps data-theme/data-mode on <body>.
// Persistence (PATCH /settings + localStorage cache) is the caller's job —
// see setTheme() in app.js.
export function applyTheme(id) {
  const t = getTheme(id);
  const root = document.documentElement;
  for (const [k, v] of Object.entries(t.vars)) {
    root.style.setProperty(`--${k}`, v);
  }
  if (document.body) {
    document.body.setAttribute('data-theme', t.id);
    document.body.setAttribute('data-mode', t.mode);
  }
  return t;
}
