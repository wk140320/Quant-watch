# Global Quant Watch UI System

## Product Character

Global Quant Watch is a research and paper-trading workstation, not a marketing site. The interface should feel calm, precise, soft enough for long sessions, and visibly serious about risk. Dense data remains compact; hierarchy comes from spacing, surface lightness, and semantic colour rather than oversized type or decorative cards.

## Colour Tokens

| Role | Token | Value | Usage |
| --- | --- | --- | --- |
| Canvas | `--qw-bg` | `#090C10` | Application background |
| Base surface | `--qw-surface-1` | `#11161C` | Panels and workspaces |
| Elevated surface | `--qw-surface-2` | `#182129` | Controls, selected areas, chart chrome |
| Primary text | `--qw-text` | `#F3F7F8` | Main labels and values |
| Action/live | `--qw-cyan` | `#5ED2C7` | Primary command, streaming and selected state |
| Model/info | `--qw-blue` | `#83B9EE` | Model evidence and informational state |
| Positive | `--qw-green` | `#72D69A` | Profit and healthy status only |
| Warning | `--qw-amber` | `#E7C06F` | Degraded source and caution |
| Risk | `--qw-rose` | `#F18492` | Loss, stop and failure only |

Only one action accent should dominate a viewport. Neutral data stays neutral; positive and negative colours must not be used decoratively.

## Geometry And Spacing

- Cards and workspaces use an 8px radius; compact controls use 6-7px; status tags may use a pill radius.
- Primary layout spacing is 20px, internal panel spacing is 14-18px, and dense table spacing is 8-10px.
- A panel may contain controls or repeated records, but page sections must not be stacked as decorative cards inside cards.
- Shadows are low contrast and paired with a subtle inset highlight. Selected rows use a two-pixel semantic edge instead of a large glow.

## Motion

- Workspace content enters over 230ms with opacity and a 6px vertical offset.
- The header remains static. Root View Transitions are disabled to prevent text tearing and old-page ghosting.
- Hover movement is limited to one or two pixels and never changes layout dimensions.
- Charts keep a stable container while series cross-fade. Loading indicators reserve their final dimensions.
- `prefers-reduced-motion` reduces all transitions to effectively instantaneous behaviour.

## Page Hierarchy

- Dashboard: sticky scrollable watchlist at roughly 4/12 width, evidence and decision detail at 8/12.
- Feature analysis: controls, primary feature chart, then order-flow evidence.
- Factor lab: experiment controls, overlay chart, candidate evidence table with a sticky identity column, then admitted-factor configuration.
- Strategy/Agent: constraints, accuracy/model evidence, persistent Paper Agents, optimal strategy, assistant and history.
- Simulation: capital/risk summary, position operations, then decision and Paper audit history.
- Data health: providers grouped by capability with summary first and expandable diagnostics.

## Runtime Contract

The browser is a view and controller. It may restore local display snapshots, but Paper Agent state, fills, rewards, news scheduling, Reddit warmup, training and backtests are backend-owned. All Paper events display source, bar time, price, slippage and reason. Real order execution remains disabled.

## Figma Handoff

The connected Figma account currently has a View seat. When edit access is available, mirror these tokens as variables and create components for segmented navigation, semantic tags, buttons, form controls, data cards, table rows, chart toolbars, dialogs and status panels. Desktop frames should cover all eight workspaces plus the background controller; mobile frames should cover navigation, dashboard, strategy and data health.
