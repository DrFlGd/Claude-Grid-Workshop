$fn = 128;

/* [Shelf Parameters] */

// Dimensions are in millimeters. Multiple shelves can fit side-by-side on the grid if your Shelf Width is an odd multiple of 28mm, such as 112mm or 196mm.
shelf_width = 84;
shelf_depth = 170;

/* [Snap Parameters] */

// openGrid snap type for connecting to base plates.
snap_type = "Directional"; // [Lite, Full, Directional]

// The fitment affects the tightness of the snap when mounted (ease of removing the peg)
// Use a value between 0.0 and 1.0, with 0.5 meaning a standard fit.
// A value between 0.66-0.75 would be a tight fit, and a value of 1.0 would be very difficult to insert and remove.
snap_fitment = 0.66;

/* [Hidden] */

/*///////////////////////////
    SHELF
*////////////////////////////

shelf_thickness = 5;
shelf_lip_height = 5;
min_snaps = 1;
max_snaps = floor(shelf_width/28);
outer_face_outset = 3;
outer_face_bottom = 3;
outer_face_top = 5;
lip_top_height = 8;
lip_top_thickness = 2;
tray_edge_inset = outer_face_outset + lip_top_thickness;

module shelf_blank() {
    // The points are grouped by corner, starting with the southwest (bottom-left) corner
    // For each corner, point 0 is on bottom of the shelf, and are ordered along the corner's edge to the outside, then up to the lip, and ending with the matching corner of the tray's inner face
    polyhedron(
        points = [
            // SW corner
            [outer_face_outset, outer_face_outset, 0], // SW corner of bottom face
            [0, 0, outer_face_bottom], // SW corner bottom of W face
            [0, 0, outer_face_top], // SW corner top of W face
            [outer_face_outset, outer_face_outset, lip_top_height], // SW outer corner of top of lip
            [lip_top_thickness, lip_top_thickness, lip_top_height], // SW inner corner of top lip
            [tray_edge_inset, tray_edge_inset, shelf_thickness], // SW corner of shelf top surface
            
            // NW corner
            [outer_face_outset, shelf_depth, 0],
            [0, shelf_depth-outer_face_outset, outer_face_bottom],
            [0, shelf_depth-outer_face_outset, outer_face_top],
            [outer_face_outset, shelf_depth, lip_top_height],
            [lip_top_thickness, shelf_depth-lip_top_thickness, lip_top_height],
            [tray_edge_inset, shelf_depth-tray_edge_inset, shelf_thickness],
            
            // NE corner
            [shelf_width-outer_face_outset, shelf_depth, 0],
            [shelf_width, shelf_depth-outer_face_outset, outer_face_bottom],
            [shelf_width, shelf_depth-outer_face_outset, outer_face_top],
            [shelf_width-outer_face_outset, shelf_depth, lip_top_height],
            [shelf_width-lip_top_thickness, shelf_depth-lip_top_thickness, lip_top_height],
            [shelf_width-tray_edge_inset, shelf_depth-tray_edge_inset, shelf_thickness],
            
            // SE corner
            [shelf_width-outer_face_outset, outer_face_outset, 0],
            [shelf_width, 0, outer_face_bottom],
            [shelf_width, 0, outer_face_top],
            [shelf_width-outer_face_outset, outer_face_outset, lip_top_height],
            [shelf_width-lip_top_thickness, lip_top_thickness, lip_top_height],
            [shelf_width-tray_edge_inset, tray_edge_inset, shelf_thickness]
        ],
        faces = [
            [0, 6, 12, 18], // bottom face
            
            [0, 1, 7, 6], // W outer bottom chamfer
            [1, 2, 8, 7], // W outer face
            [2, 3, 9, 8], // W outer top chamfer
            [3, 4, 10, 9], // W lip top face
            [4, 5, 11, 10], // W inner chamfer
            
            [6, 7, 8, 9, 15, 14, 13, 12], // N face
            [9, 10, 16, 15], // N lip top face
            [11, 10, 16, 17], // N inner chamfer
            
            [12, 13, 19, 18], // E outer bottom chamfer
            [13, 14, 20, 19], // E outer face
            [14, 15, 21, 20], // E outer top chamfer
            [15, 16, 22, 21], // E lip top face
            [16, 17, 23, 22], // E inner chamfer
            
            [18, 19, 1, 0], // S outer bottom chamfer
            [19, 20, 2, 1], // S outer face
            [20, 21, 3, 2], // S outer top chamfer
            [21, 22, 4, 3], // S lip top face
            [22, 23, 5, 4], // S inner chamfer
            
            [5, 11, 17, 23] // top face
        ]
    );
};

/*///////////////////////////
    OPENGRID SNAP
*////////////////////////////

cell_width = 28;
snap_width = 25;
snap_wall = cell_width - snap_width; // thickness of wall between snaps
snap_margin = snap_wall / 2; // thickness of one cell's portion of the wall
long_side_length = 18.2745;
short_side_length = 15.1632;
cutout_offset = (snap_width - long_side_length) / 2;
large_cutout_offset = (snap_width - short_side_length) / 2;
short_tab_length = 10.8;

part_overlap = 0.05; // For ensuring manifold geometry during boolean operations

full_snap_thickness = 6.8;
lite_snap_thickness = 3.4;
snap_diff_thickness = full_snap_thickness - lite_snap_thickness;

module large_corner_cutouts() {
    linear_extrude(height = 5.3)
        polygon(
            points = [
                [0,0],
                [0, large_cutout_offset],
                [large_cutout_offset, 0],
                [0, snap_width-large_cutout_offset],
                [0, snap_width],
                [large_cutout_offset, snap_width],
                [snap_width-large_cutout_offset, snap_width],
                [snap_width, snap_width],
                [snap_width, snap_width-large_cutout_offset],
                [snap_width, large_cutout_offset],
                [snap_width, 0],
                [snap_width-large_cutout_offset, 0]
            ],
            paths = [[0, 1, 2], [3, 4, 5], [6, 7, 8], [9, 10, 11]]
        );
};

module corner_overhang_cutout_template() {
    translate([0, 0, 5.3])
        rotate([90, 0, 45])
            linear_extrude(height = 10)
                polygon(
                    points = [
                        [0, 0],
                        [0, 1.1],
                        [1.1, 0]
                    ]
                );
};

module corner_overhang_cutouts() {
    translate([-.8, 4.162, 0])
        corner_overhang_cutout_template();
    
    rotate([0, 0, 90])
        translate([-1.65, -20,0])
            corner_overhang_cutout_template();
    
    rotate([0, 0, -90])
        translate([-27, 5.353, 0])
            corner_overhang_cutout_template();
    
    rotate([0, 0, 180])
        translate([-27, -19.64, 0])
            corner_overhang_cutout_template();
};

module bottom_slot_cutout_template() {
    hull()
        linear_extrude(height = 6.2) {
            circle(r = 0.4);
            translate([11.8, 0, 0]) {
                circle(r = 0.4);
            };
        };
};

module bottom_slot_cutouts(snap_type) {
    slot_inset = 1.5;

    if (snap_type == "Directional") {
        rotate([13, 0, 0])
            translate([6.75, slot_inset,-7])
                scale([1, 1, 2])
                    bottom_slot_cutout_template();
    } else {
        translate([6.75, slot_inset,-7])
            scale([1, 1, 2])
                bottom_slot_cutout_template();
    }

    // Left side
    translate([slot_inset, 7, -0.01])
        rotate([0, 0, 90])
            bottom_slot_cutout_template();
    
    // Right side
    translate([snap_width - slot_inset, 7, -0.01])
        rotate([0, 0, 90])
            bottom_slot_cutout_template();
    
    // Top, for non-Directional snaps
    if (snap_type != "Directional") {
        translate([6.75, snap_width - slot_inset,-7])
            scale([1, 1, 2])
                bottom_slot_cutout_template();
    }
};

// Generates a cutout of an equilateral triangle
// used to emboss as a directional indicator for Directional snaps
module triangle_directional_cutout_template(side_length, thickness) {

    height = side_length * 0.866; // sin60 = 0.866

    linear_extrude(height = thickness)
        polygon(
            points = [
                [0, 0],
                [side_length, 0],
                [side_length / 2.0, height],
            ],
        );
};

module triangle_directional_cutout() {
    triangle_side_length = 3;
    cutout_thickness = 0.4;

    translate([(snap_width-triangle_side_length)/2, snap_width - 6, -0.1])
        triangle_directional_cutout_template(triangle_side_length, cutout_thickness);
};

module side_slot_cutouts(snap_type) {
    length = 11.4;
    width = 1;
    height = 0.4;
    top_shelf_thickness = 1.2;
    top_distance = full_snap_thickness - top_shelf_thickness;
    
    // Left side
    translate([.75, 7, top_distance])
        rotate([0, 0, 90])
            cube([length, width, height]);
    
    // Right side
    translate([snap_width-width+width, 7, top_distance])
        rotate([0, 0, 90])
            cube([length, width, height]);
    
    // Bottom
    translate([7, 0, top_distance])
        cube([length, width, height]);
    
    // Top, for non-Directional snaps
    if (snap_type != "Directional") {
        translate([7, snap_width, top_distance])
            cube([length, width, height]);
    }
};

module snap_tab(x_scale, y_scale, z_scale) {
    base_x = 14 * x_scale;
    base_y = 4 * y_scale;
    top_x = 9.5 * x_scale;
    top_y = 2.2 * y_scale;
    height = 0.8 * z_scale;

    // Offsets to center the top over the base
    dx = (base_x - top_x) / 2;
    dy = (base_y - top_y) / 2;

    points = [
        // Base (Z = 0)
        [0,      0,      0],  // 0, bottom-left of big face
        [base_x, 0,      0],  // 1, bottom-right of big face
        [base_x, base_y, 0],  // 2, top-right of big face
        [0,      base_y, 0],  // 3, top-left of big face

        // Top (Z = height), centered
        [dx,        dy,        height],  // 4, bottom-left of small face
        [dx+top_x,  dy,        height],  // 5, bottom-right of small face
        [dx+top_x,  dy+top_y,  height],  // 6, top-right of small face
        [dx,        dy+top_y,  height]   // 7, top-left of small face
    ];

    faces = [
        [0, 3, 2, 1],  // bottom
        [0, 1, 5, 4],  // side 1, front
        [0, 4, 7, 3],  // side 2, left
        [1, 2, 6, 5],  // side 3, right
        [2, 3, 7, 6],  // side 4, rear
        [4, 5, 6, 7],  // top
    ];

    polyhedron(points=points, faces=faces);
};

module snap_tab_large(fitment) {
    snap_tab(x_scale = 1.0, y_scale = 1.0, z_scale = fitment);
};

module snap_tab_small(fitment) {
    snap_tab(x_scale = 0.8, y_scale = 0.5, z_scale = fitment);
};

module top_tab(type, fitment) {
    // full or lite tab for top edge
    if (type == "Directional") {
        // full tab for directional snaps
        translate([(snap_width+14)/2, snap_width - part_overlap, 1.4])
            rotate([90, 0, 180])
                snap_tab_large(fitment = 1.0);
    } else {
        // lite tab for non-directional snaps
        translate([(snap_width+short_tab_length)/2+0.4, snap_width - part_overlap, snap_diff_thickness])
            rotate([90, 0, 180])
                snap_tab_small(fitment);
    }
};

module right_tab(fitment) {
    translate([snap_width - part_overlap, (snap_width-short_tab_length)/2, snap_diff_thickness])
        rotate([90, 0, 90])
            snap_tab_small(fitment);
};

module left_tab(fitment) {
    translate([part_overlap, (snap_width+short_tab_length)/2+0.4, snap_diff_thickness])
        rotate([90, 0, -90])
            snap_tab_small(fitment);
};

module bottom_tab(fitment) {
    translate([(snap_width-short_tab_length)/2, part_overlap, snap_diff_thickness])
        rotate([90, 0, 0])
            snap_tab_small(fitment);
};

module lite_snap_cutout() {
    linear_extrude(height = snap_diff_thickness)
        polygon(
            points = [
                [0, 0],
                [0, 30],
                [30, 30],
                [30, 0]
            ]
        );
}

module bottom_half_snapfit_cutter() {
    rotate([90, 0, 90])
        linear_extrude(height = 20)
            polygon(
                points = [
                    [0, 0],
                    [0.8, 0], 
                    [0, 3.4]
                ]
            );
};

module bottom_half_snapfit_cutouts() {
    translate([3, 0, 0])
        bottom_half_snapfit_cutter();

    translate([snap_width-cutout_offset-1.555, 0, 0])
        rotate([0, 0, 45])
            bottom_half_snapfit_cutter();
            
    translate([-3, 7.918, 0])
        rotate([0, 0, -45])
            bottom_half_snapfit_cutter();
};

module primary_box() {
    linear_extrude(height = full_snap_thickness)
        polygon(
            points = [
                [0, cutout_offset],
                [0, cutout_offset+long_side_length],
                [cutout_offset, snap_width],
                [cutout_offset+long_side_length, snap_width],
                [snap_width, cutout_offset+long_side_length],
                [snap_width, cutout_offset],
                [cutout_offset+long_side_length, 0],
                [cutout_offset, 0]
            ]
        );
};

module opengrid_snap(snap_type, fitment) {
    union() {
        difference() {
            primary_box();

            large_corner_cutouts();
            corner_overhang_cutouts();

            bottom_slot_cutouts(snap_type);
            side_slot_cutouts(snap_type);
            
            if (snap_type == "Directional") {
                triangle_directional_cutout();
                bottom_half_snapfit_cutouts();
            }

            if (snap_type == "Lite") {
                lite_snap_cutout();
            }
        };
        top_tab(type = snap_type, fitment = fitment);
        bottom_tab(fitment = fitment);
        left_tab(fitment = fitment);
        right_tab(fitment = fitment);
    };
};

/*///////////////////////////
    FINAL ASSEMBLY
*////////////////////////////

module snap_chamfer() {
    translate([snap_width, snap_width/6, full_snap_thickness])
        rotate([90, -90, -90])
            linear_extrude(height = snap_width)
                polygon(
                    points = [
                        [0, 0],
                        [lip_top_thickness*2, 0],
                        [0, lip_top_height + 8]
                    ],
                    paths = [[0, 1, 2]]
                );
};

total_width = shelf_width;

cell_count = floor(shelf_width / cell_width);

even_cell_count = (cell_count % 2 == 0) ? true : false;
snap_count = (even_cell_count) ? floor(cell_count / 2) : floor(cell_count / 2) + 1;
even_snap_count = (snap_count % 2 == 0) ? true : false;
gap_count = (even_cell_count) ? floor(cell_count / 2) - 1 : floor(cell_count/2);
gap_width = cell_width;

snap_remainder = shelf_width - (cell_count * cell_width);
outer_snap_offset = even_cell_count ? (snap_remainder + cell_width)/2 : snap_remainder / 2;

union() { 
    translate([-outer_snap_offset - snap_margin, snap_width/6, shelf_depth+full_snap_thickness])
        rotate([-90, 0, 0])
            shelf_blank();

    for (i = [0 : snap_count - 1]) {
        translate([i * (cell_width * 2), 0, 0])
            union() {
                snap_chamfer();
                opengrid_snap(snap_type = snap_type, fitment = snap_fitment);
            };
    }
};
