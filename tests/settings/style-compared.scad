// The style is only named where it's compared: a drop-down of the three
style = "round";
label = "Box";
if (style == "square") cube(10);
else if (style == "hex") cylinder(d = 10, h = 10, $fn = 6);
else cylinder(d = 10, h = 10);
if (label != "") linear_extrude(1) text(label);
