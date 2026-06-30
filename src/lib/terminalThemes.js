// Palettes pour le terminal xterm de l'onglet Terminal. Chaque entrée : { name, theme } où `theme`
// est un ITheme xterm (background/foreground/cursor + 16 couleurs ANSI). Le choix est persisté en
// localStorage (cf. SessionDetail). L'ordre des clés = ordre du sélecteur.

export const TERM_THEMES = {
  hooked: {
    name: 'Hooked',
    theme: {
      background: '#0b0e14', foreground: '#c7d0e0', cursor: '#7dd3fc', cursorAccent: '#0b0e14',
      selectionBackground: '#22304a',
      black: '#0b0e14', red: '#ff6b6b', green: '#7bd88f', yellow: '#e5c07b', blue: '#61afef',
      magenta: '#c678dd', cyan: '#56b6c2', white: '#c7d0e0',
      brightBlack: '#5c6773', brightRed: '#ff8585', brightGreen: '#9ae6a4', brightYellow: '#f0d399',
      brightBlue: '#80c0ff', brightMagenta: '#d99ee8', brightCyan: '#7fd3dd', brightWhite: '#ffffff',
    },
  },
  dark: {
    name: 'Dark (VS Code)',
    theme: {
      background: '#1e1e1e', foreground: '#d4d4d4', cursor: '#d4d4d4', cursorAccent: '#1e1e1e',
      selectionBackground: '#264f78',
      black: '#000000', red: '#cd3131', green: '#0dbc79', yellow: '#e5e510', blue: '#2472c8',
      magenta: '#bc3fbc', cyan: '#11a8cd', white: '#e5e5e5',
      brightBlack: '#666666', brightRed: '#f14c4c', brightGreen: '#23d18b', brightYellow: '#f5f543',
      brightBlue: '#3b8eea', brightMagenta: '#d670d6', brightCyan: '#29b8db', brightWhite: '#ffffff',
    },
  },
  dracula: {
    name: 'Dracula',
    theme: {
      background: '#282a36', foreground: '#f8f8f2', cursor: '#f8f8f2', cursorAccent: '#282a36',
      selectionBackground: '#44475a',
      black: '#21222c', red: '#ff5555', green: '#50fa7b', yellow: '#f1fa8c', blue: '#bd93f9',
      magenta: '#ff79c6', cyan: '#8be9fd', white: '#f8f8f2',
      brightBlack: '#6272a4', brightRed: '#ff6e6e', brightGreen: '#69ff94', brightYellow: '#ffffa5',
      brightBlue: '#d6acff', brightMagenta: '#ff92df', brightCyan: '#a4ffff', brightWhite: '#ffffff',
    },
  },
  nord: {
    name: 'Nord',
    theme: {
      background: '#2e3440', foreground: '#d8dee9', cursor: '#d8dee9', cursorAccent: '#2e3440',
      selectionBackground: '#434c5e',
      black: '#3b4252', red: '#bf616a', green: '#a3be8c', yellow: '#ebcb8b', blue: '#81a1c1',
      magenta: '#b48ead', cyan: '#88c0d0', white: '#e5e9f0',
      brightBlack: '#4c566a', brightRed: '#bf616a', brightGreen: '#a3be8c', brightYellow: '#ebcb8b',
      brightBlue: '#81a1c1', brightMagenta: '#b48ead', brightCyan: '#8fbcbb', brightWhite: '#eceff4',
    },
  },
  solarizedDark: {
    name: 'Solarized Dark',
    theme: {
      background: '#002b36', foreground: '#839496', cursor: '#93a1a1', cursorAccent: '#002b36',
      selectionBackground: '#073642',
      black: '#073642', red: '#dc322f', green: '#859900', yellow: '#b58900', blue: '#268bd2',
      magenta: '#d33682', cyan: '#2aa198', white: '#eee8d5',
      brightBlack: '#586e75', brightRed: '#cb4b16', brightGreen: '#586e75', brightYellow: '#657b83',
      brightBlue: '#839496', brightMagenta: '#6c71c4', brightCyan: '#93a1a1', brightWhite: '#fdf6e3',
    },
  },
  gruvbox: {
    name: 'Gruvbox Dark',
    theme: {
      background: '#282828', foreground: '#ebdbb2', cursor: '#ebdbb2', cursorAccent: '#282828',
      selectionBackground: '#504945',
      black: '#282828', red: '#cc241d', green: '#98971a', yellow: '#d79921', blue: '#458588',
      magenta: '#b16286', cyan: '#689d6a', white: '#a89984',
      brightBlack: '#928374', brightRed: '#fb4934', brightGreen: '#b8bb26', brightYellow: '#fabd2f',
      brightBlue: '#83a598', brightMagenta: '#d3869b', brightCyan: '#8ec07c', brightWhite: '#ebdbb2',
    },
  },
  light: {
    name: 'Light',
    theme: {
      background: '#fafafa', foreground: '#383a42', cursor: '#526fff', cursorAccent: '#fafafa',
      selectionBackground: '#cfe2ff',
      black: '#383a42', red: '#e45649', green: '#50a14f', yellow: '#c18401', blue: '#4078f2',
      magenta: '#a626a4', cyan: '#0184bc', white: '#fafafa',
      brightBlack: '#a0a1a7', brightRed: '#e45649', brightGreen: '#50a14f', brightYellow: '#c18401',
      brightBlue: '#4078f2', brightMagenta: '#a626a4', brightCyan: '#0184bc', brightWhite: '#ffffff',
    },
  },
};

export const DEFAULT_TERM_THEME = 'hooked';

// Polices du terminal. « Nerd Font » : texte en JetBrains Mono (Nerd Font installée si présente,
// sinon « JetBrains Mono Web » EMPAQUETÉE) + repli par glyphe sur « Symbols Nerd Font Mono Web »
// (EMPAQUETÉE) pour les icônes → les glyphes Nerd Font marchent même SANS rien installer. Retombe
// sur une mono système en dernier recours.
export const TERM_FONTS = {
  nerd: {
    name: 'Nerd Font',
    family: '"JetBrainsMono Nerd Font Mono", "JetBrainsMono Nerd Font", "MesloLGS NF", "JetBrains Mono Web", "Symbols Nerd Font Mono", "Symbols Nerd Font Mono Web", ui-monospace, SFMono-Regular, Menlo, monospace',
  },
  mono: {
    name: 'System Mono',
    family: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
  },
};

export const DEFAULT_TERM_FONT = 'nerd';
