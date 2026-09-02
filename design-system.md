# Continuum Canvas design system

Version: 1.0<br>
Scope: the browser workbench, shell controls, canvas overlays, inspector,
workspace home and collaboration UI.

## 1. Intent and reference boundary

This document is the project-owned implementation contract. It adapts the
typographic roles, monochrome UI direction, spacing rhythm and compact icon
button guidance from the Figma-inspired reference supplied for this project:

- [colorspace-skill Figma reference README](https://raw.githubusercontent.com/Duanjyy/colorspace-skill/main/design-md/figma/README.md)
- [colorspace-skill Figma reference DESIGN.md](https://raw.githubusercontent.com/Duanjyy/colorspace-skill/main/design-md/figma/DESIGN.md)

The supplied README explicitly describes the material as a non-official
extraction and a starting point, not as Figma's official design system. The
reference is therefore used as a measurement and design-language input, not as
a source of artwork or an endorsement. This project does not bundle
`figmaSans`, `figmaMono`, Figma logos/wordmarks, screenshots, proprietary icon
paths or copied illustrations.

This is design and engineering guidance, not a legal opinion. Functional
ideas such as a type scale, an 8px rhythm or semantic color roles are normally
safe to re-implement, but exact brand identifiers, font files, logo geometry,
icon path data and a highly distinctive combination of trade dress can create
copyright, trademark or passing-off risk. Public or commercial distribution
should receive a jurisdiction-specific review from counsel. The upstream
`awesome-design-md` collection publishes its own repository under MIT; that
license does not automatically license assets in every referenced project.

## 2. Token architecture

Tokens live in [`src/styles/tokens.css`](src/styles/tokens.css) and follow a
three-layer contract:

1. **Primitives** are raw palette values (`--canvas-primitive-*`). They are
   changed centrally when the visual theme changes.
2. **Semantics** describe a role (`--canvas-bg-surface`,
   `--canvas-text-secondary`, `--canvas-status-danger`, and so on). Components
   should consume these roles rather than a hex value or an ad-hoc alpha.
3. **Component-facing roles** expose typography and icon contracts. A
   component may add a local alias, but the alias must point to a semantic
   token rather than introduce a new color literal.

The product is a dark, canvas-first application. The reference's monochrome
direction is mapped to dark Zinc elevations here; its light marketing-page
palette is not pasted wholesale into the workbench.

### Color roles

| Role | Token examples | Use |
| --- | --- | --- |
| Canvas/background | `--canvas-bg-canvas`, `--canvas-bg-base`, `--canvas-bg-surface`, `--canvas-bg-elevated`, `--canvas-bg-input` | Canvas, shell, panels, popovers, fields |
| Text | `--canvas-text-primary`, `--canvas-text-primary-strong`, `--canvas-text-secondary`, `--canvas-text-muted`, `--canvas-text-disabled` | Titles, body copy, labels, hints and disabled states |
| Brand accent | `--canvas-accent-primary`, `--canvas-accent-hover`, `--canvas-accent-subtle`, `--canvas-accent-purple` | Links, selected controls and agent affordances |
| Support accent | `--canvas-accent-support`, `--canvas-accent-support-subtle`, `--canvas-accent-support-muted` | Collaboration/rail support states |
| Status | `--canvas-status-success`, `--canvas-status-warning`, `--canvas-status-danger` and their `*-subtle` roles | State, validation, progress and error feedback |
| Border/focus | `--canvas-border-subtle`, `--canvas-border-default`, `--canvas-border-strong`, `--canvas-border-focus`, `--canvas-focus-outline` | Dividers, controls and keyboard focus |
| Overlay | `--canvas-overlay-black-*`, `--canvas-overlay-white-*` | Scrims, glass, shadows and hover layers |

Use `color`, `background`, `border`, `outline`, `box-shadow` and SVG
`currentColor` through these roles. Do not add a new literal to a component
just to make a shade look a little different; add or adjust a semantic role
when the distinction is meaningful.

There are two intentional exceptions. Canvas model data (`node.data.color`,
`fill`, `stroke`, drawing brushes and collaboration member colors) is serialized
content and must remain a concrete color so a document can be rendered outside
the DOM. Thumbnail/canvas drawing code also needs concrete colors because the
Canvas 2D API cannot resolve CSS custom properties. These values are content or
rendering inputs, not UI chrome; their defaults are documented in the relevant
model code and should not be confused with CSS theme tokens.

## 3. Typography

The reference names proprietary font families. Continuum Canvas intentionally
uses a system/CJK stack so it can run offline and does not redistribute those
fonts:

```css
font-family: var(--canvas-font-sans);
font-feature-settings: var(--canvas-font-feature-default);
font-kerning: normal;
font-synthesis: var(--canvas-font-synthesis);
```

The stack is Apple/system UI, PingFang SC, Inter, Noto Sans SC, Microsoft YaHei,
`system-ui` and `sans-serif`, with a separate system-monospace stack for
eyebrows and captions. Variable weights below are intentional; a static
fallback will clamp them to its supported weights.

The reference material contains a small Display-weight discrepancy: its
narrative names 340 while one table cell says 400. This project pins Display
roles to 340 to follow the variable-axis narrative; the choice is centralized
in the two Display weight tokens and can be changed without editing components.

| Role | Size | Weight | Line height | Tracking | Token prefix |
| --- | ---: | ---: | ---: | ---: | --- |
| Display XL | 86px | 340 | 1.00 | -1.72px | `--canvas-type-display-xl-*` |
| Display LG | 64px | 340 | 1.10 | -0.96px | `--canvas-type-display-lg-*` |
| Headline | 26px | 540 | 1.35 | -0.26px | `--canvas-type-headline-*` |
| Subhead | 26px | 340 | 1.35 | -0.26px | `--canvas-type-subhead-*` |
| Card title | 24px | 700 | 1.45 | 0 | `--canvas-type-card-title-*` |
| Body large | 20px | 330 | 1.40 | -0.14px | `--canvas-type-body-lg-*` |
| Body | 18px | 320 | 1.45 | -0.26px | `--canvas-type-body-*` |
| Body small | 16px | 330 | 1.45 | -0.14px | `--canvas-type-body-sm-*` |
| Link | 20px | 480 | 1.40 | -0.10px | `--canvas-type-link-*` |
| Button | 20px | 480 | 1.40 | -0.10px | `--canvas-type-button-*` |
| Eyebrow (mono) | 18px | 400 | 1.30 | +0.54px | `--canvas-type-eyebrow-*` |
| Caption (mono) | 12px | 400 | 1.00 | +0.60px | `--canvas-type-caption-*` |

The utility classes `.canvas-type-*` are defined in `src/index.css`. Existing
canvas chrome includes a denser 8–14px information layer to keep node labels,
inspectors and tool docks usable at high zoom. That density is a product
constraint, not a second brand system; new prominent copy should use the roles
above, and dense labels should use the caption/body-small family consistently.

Example:

```css
.panel-title {
  color: var(--canvas-text-primary);
  font-size: var(--canvas-type-body-lg-size);
  font-weight: var(--canvas-type-body-lg-weight);
  line-height: var(--canvas-type-body-lg-leading);
  letter-spacing: var(--canvas-type-body-lg-tracking);
}
```

## 4. Icons and SVG independence

The canonical product icon source is `lucide-react`, already used by the shell,
workspace and tool dock. Lucide supplies independent SVG geometry; it is not a
copy of the Figma reference's artwork. The installed package declares the ISC
license; keep its license notice when redistributing a built application.
`IconButton` centralizes accessible
labels, tooltip text, `aria-pressed`, and hidden decorative SVG behavior.

| Contract | Value |
| --- | ---: |
| Extra small | 12px |
| Small | 14px |
| Medium/default | 16px |
| Large | 20px |
| Extra large | 24px |
| Circular/pill icon button | 40px |
| Default stroke | 1.75 |
| Emphasis stroke | 2.25 |
| Focus outline | 2px dashed semantic focus color |

The reference does not define path geometry or a stroke-width value. The sizes,
stroke values and colors above are Continuum Canvas choices that make the
reference's component guidance implementable without copying its paths.

When a new project-owned SVG is required:

- draw original geometry in a 24×24 `viewBox`; do not trace or paste a Figma
  path, logo or screenshot;
- prefer `fill="none"`, `stroke="currentColor"`, round caps and joins;
- expose size and emphasis through the icon tokens, not per-component hex
  values;
- provide an accessible name when the SVG conveys meaning; otherwise mark it
  decorative and put the label on the control;
- keep brand/social marks separate from the UI icon set and follow their own
  trademark and license requirements.

The existing `LibTvLogo` is project-owned geometry. Social/template sprites
and favicon assets are brand/content assets, not the semantic UI icon system.

## 5. Migration status

The current migration has:

- moved the global, shell, workspace home, inspector, overlays, asset manager
  and generation-history font stacks to `--canvas-font-*`;
- added typography role utilities and consistent font feature/kerning defaults;
- moved production UI stylesheet colors (shell, canvas controls, overlays,
  inspector, workspace and history), status states, avatar fallbacks and SVG
  icon colors to semantic variables; `tokens.css` is the only stylesheet that
  intentionally contains the primitive color literals;
- aligned the shell icon buttons, tool dock and workspace icons to the size and
  stroke contract;
- replaced the old solid global focus ring with the 2px dashed semantic focus
  treatment;
- kept content colors and Canvas 2D defaults concrete for serialization and
  rendering correctness, as described in §2.

Future UI work should treat a raw color in a component stylesheet as a review
signal. Before adding one, decide whether it is a semantic role, a content
value, or a third-party/brand asset and record that decision in the component.

## 6. Review checklist

- Does the component consume a semantic `--canvas-*` color rather than a hex or
  ad-hoc alpha?
- Is the type role explicit (or intentionally dense) with size, weight,
  leading and tracking inherited from a token?
- Is the SVG geometry independent, 24×24 where appropriate, and styled with
  `currentColor`?
- Are icon-only controls labeled and keyboard focus visible?
- Does a change preserve the dark canvas contrast and CJK fallback behavior?
- Are serialized model/content colors kept concrete and out of CSS token
  assumptions?
- Have `npm run lint`, `npm test` and `npm run build` passed before syncing the
  branch?
