// Compared in a ternary and inside a module that takes the setting under the same name
lid_type = "snap"; // the lid
corner = "rounded";
module box(lid_type) {
  h = lid_type == "slide" ? 4 : lid_type == "none" ? 0 : 3;
  cube([20, 20, 10 + h]);
}
box(lid_type);
r = "sharp" == corner ? 0 : 2;
