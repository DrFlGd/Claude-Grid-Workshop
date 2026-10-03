# Monokini — Customizable Underware for openGrid

**Monokini** is the customizable Underware for the openGrid profile — an [OpenSCAD](https://openscad.org/) parametric library for generating 3D-printable cable-management channels fully compatible with [openGrid](https://www.printables.com/model/757405-opengrid) plates by **@David D**. All pieces are fully customisable through the built-in OpenSCAD Customizer.

> Created by **Pedro Leite**  
> Inspired by the Underware 2.0 collection by **Hands on Katie** and **BlackjackDuck (Andy)**  
> Licensed under [Creative Commons 4.0 Attribution Non-Commercial Share-Alike (CC-BY-NC-SA)](https://creativecommons.org/licenses/by-nc-sa/4.0/)  
> Original Underware 2.0 documentation: <https://handsonkatie.com/underware-2-0-the-made-to-measure-collection/>

---

## Requirements

| Requirement | Notes |
|---|---|
| [OpenSCAD](https://openscad.org/) ≥ 2021.01 | The nightly build is recommended for the latest features |
| [BOSL2](https://github.com/BelfrySCAD/BOSL2) | Must be installed as an OpenSCAD library (see [BOSL2 installation guide](https://github.com/BelfrySCAD/BOSL2/wiki/Installation)) |

---

## Files Overview

| File | Description |
|---|---|
| `monokini_I_channel.scad` | Standard straight channel — the most common piece |
| `monokini_I_bridge_channel.scad` | Straight channel with an elevated bridge section that clears an obstacle below |
| `monokini_I_height_change_channel.scad` | Straight channel that transitions smoothly between two different heights |
| `monokini_I_width_change_channel.scad` | Straight channel that transitions smoothly between two different widths |
| `monokini_I_channel_tex.scad` | Straight channel with a BOSL2 built-in surface texture on the top face |
| `monokini_I_channel_wood.scad` | Straight channel with a procedural wood-grain texture on the top face |
| `monokini_I_channel_hok.scad` | Straight channel with a custom PNG image projected as a surface texture |
| `monokini_I_channel_leaf.scad` | Straight channel with a decorative leaf pattern on the top face |
| `monokini_L_channel.scad` | 90-degree corner channel |
| `monokini_T_channel.scad` | T-junction channel (three-way split) |
| `monokini_X_channel.scad` | Cross-junction channel (four-way split) |
| `monokini_S_channel.scad` | Offset (S-shaped) channel that shifts laterally along the X axis |
| `monokini_diagonal_channel.scad` | Diagonal channel with straight entry/exit sections |
| `monokini_mitre_channel.scad` | 45-degree mitre corner channel |
| `monokini_bridge_channel.scad` | Multi-axis bridge channel with configurable rise and span |
| `monokini_cable_winder.scad` | Standalone cable-winder accessory that snaps onto a channel |
| `monokini_text_label.scad` | Flat label tile with embossed or debossed text, compatible with the channel grid |

---

## Quick Start

1. Install OpenSCAD and the BOSL2 library (see [Requirements](#requirements)).
2. Open any `.scad` file in OpenSCAD.
3. Open the **Customizer** panel (`Window › Customizer`).
4. Adjust the parameters to fit your installation and click **Render** (`F6`).
5. Export as STL (`File › Export › Export as STL…`) and slice with your preferred slicer.

> **Tip — Multi-colour labels:** Labels only work on MakerWorld. Export as 3MF and import into your slicer as a project (not as geometry).

---

## Customizer Parameters

All files share a common set of parameter groups.

### Channel Size
| Parameter | Description |
|---|---|
| `Channel_Width_in_Units` | Width (X axis) in grid units (1 unit = 28 mm by default) |
| `Channel_Total_Height` | Total height including the connector base (Z axis, in mm) |
| `Channel_Length_Units` | Length (Y axis) in grid units |

### Cord Cutouts
| Parameter | Description |
|---|---|
| `Number_of_Cord_Cutouts` | How many cutouts to add along the channel |
| `Cord_Side_Cutouts` | Which side(s) to cut: `Left Side`, `Right Side`, `Both Sides`, `None`, `Left Side Top`, `Right Side Top` |
| `Cord_Cutout_Width` | Width of each cutout (mm) |
| `Distance_Between_Cutouts` | Spacing between cutouts (mm) |
| `Shift_Cutouts_Forward_or_Back` | Y-axis offset for cutout placement (mm) |

### Text Label
| Parameter | Description |
|---|---|
| `Add_Label` | Enable/disable the text label |
| `Text` | String to display |
| `Font` | Font name (must be installed locally when using OpenSCAD offline) |
| `Font_Style` | Style variant (e.g. `Bold`, `Italic`) |
| `Text_size` | Font size (mm) |
| `Text_Depth` | Depth of emboss/deboss (mm, increments of 0.2 recommended) |
| `Text_Color` | Preview colour of the label text |
| `Text_Emboss` | `true` = text stands proud; `false` = text is recessed |

### Advanced Options
| Parameter | Description |
|---|---|
| `Global_Color` | Preview colour of the part body |
| `Suppress_Connectors` | Suppression key per channel segment: `N` = none, `L` = suppress left, `R` = suppress right, `B` = suppress both, `S` = static (no flaring). Separate multiple entries with commas |
| `Decorative` | When `true`, produces a solid decorative profile without functional connectors |
| `Grip_Flare` | Flare angle (degrees) applied to the snap-grip connector |

---

## Credits

- **Pedro Leite** — author of Monokini, the customizable Underware for openGrid profile
- **Katie** and her community at [Hands on Katie](https://www.youtube.com/@HandsOnKatie) (YouTube, Patreon, Discord) — inspiration
- **@David D** on Printables — [openGrid](https://www.printables.com/model/757405-opengrid)
- **Jonathan** at Keep Making — Multiboard
- **@cosmicdust** (MakerWorld) / **@freakadings_1408562** (Printables) — diagonal and turn concepts
- **@siyrahfall+1155967** on Printables — top exit holes concept
- **@Lyric** on Printables — flush connector concept
- **@fawix** on GitHub — parameter descriptor contributions
- **@BlackjackDuck** on Printables — original profiles and channel concept

---

## Change Log

| Date | Change |
|---|---|
| 2024-12-06 | Initial release |
| 2024-12-09 | Fix threading of snap connector (flare + new slop parameter) |
| 2025-03-20 | Stronger profile options |
| 2025-04-13 | Initial implementation for openGrid |

---

## License

This project is licensed under the **GNU Affero General Public License v3.0** — see the [LICENSE](LICENSE) file for details.

All 3D models and derived parts are additionally subject to the terms of **Creative Commons 4.0 Attribution Non-Commercial Share-Alike (CC-BY-NC-SA)**.
