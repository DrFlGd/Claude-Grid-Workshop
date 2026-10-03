# QuackWorks

QuackWorks is an OpenSCAD project centered around parametric functional prints. This repo houses multiple collections and some simpler one-off projects.

The following are publicly available systems. New features continue to be developed for these systems as feedback is received: 
1. Underware - Infinite Cable Management (https://makerworld.com/en/models/783010)
2. Deskware - A Modular Desk System (https://makerworld.com/en/models/1331760-deskware-a-modular-desk-system)
3. NeoGrid 2.0 - Drawer Management System (https://makerworld.com/en/models/1501061-neogrid-2-0-drawer-management-system)
4. BJD's Multiconnect Part Generators (https://makerworld.com/en/models/582260)
5. openGrid Tile Generator (https://makerworld.com/en/models/1304337-opengrid-tile-generator)

The following are additional one-off projects. These projects are functional and print-tested, but may not receive as much attention as the above systems: 
1. Customizable US Electrical Box Extension (https://makerworld.com/en/models/1252965-customizable-us-electrical-box-extension)
2. Underware Drawer v1 (https://makerworld.com/en/models/1253194-underware-drawer-v1-customizable)

## Installation Instructions
NOTE: Most models within this repository are available on MakerWorld's Web-based generator and do not require install. Some features or projects may still be in beta and therefore not yet available on MakerWorld. If you wish to install OpenSCAD and run the models locally, follow the following steps. 

### Install Local OpenSCAD Developer Release
Install the latest developer release of OpenSCAD found at https://openscad.org/downloads.html
NOTE: The regular release of OpenSCAD will not work for most files found in this library. The Developer Release is required for performance and compatibility.

### Install BOSL2 Library
Download the latest BOSL2 Library (https://github.com/BelfrySCAD/BOSL2), unzip, rename the folder to BOSL2, and place in the OpenSCAD library folder found at File > Show Library Folder.

## Example in OpenSCAD

![image](https://github.com/user-attachments/assets/1fb201eb-66d4-4f9b-b52b-4cf9fbe7a652)

## Multiconnect Development Standards

- Backer Standards
    - Back types as a single module accepting height and width parameters
    - All customizable parameters for a back type must be enclosed in their own parameter section
    - All backs must have parameterized spacing to accomodate various mounting surfaces (e.g., 25mm for Multiboard and 28mm for openGrid)
- Positioning Standards
    - Model starts at X 0 and goes positive
    - Back starts at X 0 and goes negative
    - Center the entire unit on x axis last
- Testing Critiera
    - Compiles without error
    - Test items under 5mm in height, depth, and width and verify back generates properly
    - Test for very large items

## Contributing

We use [BOSL2](https://github.com/BelfrySCAD/BOSL2) as a dependency and needs to be install accordingly.
If you have [nix](https://nixos.org/) installed with flakes activated, then everything will be setup for you with `nix develop`.

## License

Shield: [![CC BY-NC-SA 4.0][cc-by-nc-sa-shield]][cc-by-nc-sa]

This work is licensed under a
[Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International License][cc-by-nc-sa].

[![CC BY-NC-SA 4.0][cc-by-nc-sa-image]][cc-by-nc-sa]

[cc-by-nc-sa]: http://creativecommons.org/licenses/by-nc-sa/4.0/
[cc-by-nc-sa-image]: https://licensebuttons.net/l/by-nc-sa/4.0/88x31.png
[cc-by-nc-sa-shield]: https://img.shields.io/badge/License-CC%20BY--NC--SA%204.0-lightgrey.svg
