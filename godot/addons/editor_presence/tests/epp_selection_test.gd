extends SceneTree

# Headless test for EppSelection — frame construction from fake engine
# objects, no editor required. Run with:
#   godot --headless --path godot --script addons/editor_presence/tests/epp_selection_test.gd
#
# A Node can be constructed and inspected in a plain SceneTree script
# (Node.new(), scene_file_path, get_path_to(), etc. are all core engine
# API, not editor-only) — that is exactly what makes this file provable
# without EditorSelection ever being touched. Only the REAL selection
# binding in plugin.gd is unverified; see the addon's README.

const EppSelection = preload("res://addons/editor_presence/epp_selection.gd")

var _pass_count := 0
var _fail_count := 0

func _check(name: String, condition: bool, detail: String = "") -> void:
	if condition:
		_pass_count += 1
		print("PASS ", name)
	else:
		_fail_count += 1
		print("FAIL ", name, " — ", detail)

func _initialize() -> void:
	_test_saved_scene_node()
	_test_root_node()
	_test_unsaved_scene_node()
	_test_resource_item()
	_test_folder_item()
	_test_deterministic_ordering_and_union()
	_test_invalid_node_skipped()
	_test_cap_at_64()

	print("---")
	print("RESULT pass=", _pass_count, " fail=", _fail_count)
	quit(1 if _fail_count > 0 else 0)

func _make_scene(scene_path: String) -> Node:
	var root := Node.new()
	root.name = "Arena"
	if scene_path != "":
		root.scene_file_path = scene_path
	return root

func _test_saved_scene_node() -> void:
	var root := _make_scene("res://Scenes/Arena.tscn")
	var systems := Node.new()
	systems.name = "Systems"
	root.add_child(systems)
	var player := Node.new()
	player.name = "PlayerRoot"
	systems.add_child(player)

	var item := EppSelection.build_scene_item(player, root)
	_check("saved node: kind", item["kind"] == "node", str(item["kind"]))
	_check("saved node: label", item["label"] == "PlayerRoot", str(item["label"]))
	_check("saved node: path", item["path"] == "Scenes/Arena.tscn", str(item["path"]))
	_check(
		"saved node: id has anchor+relpath shape",
		String(item["id"]).begins_with("godot:v1:") and String(item["id"]).ends_with("#Systems/PlayerRoot"),
		str(item["id"]),
	)
	_check(
		"saved node: detail carries hierarchy",
		String(item["detail"]).find("Arena / Systems / PlayerRoot") != -1,
		str(item["detail"]),
	)
	root.free()

func _test_root_node() -> void:
	var root := _make_scene("res://Scenes/Arena.tscn")
	var item := EppSelection.build_scene_item(root, root)
	_check("root node: rel path is '.'", String(item["id"]).ends_with("#."), str(item["id"]))
	_check("root node: detail is just the root name", item["detail"].begins_with("Node · Arena"), str(item["detail"]))
	root.free()

func _test_unsaved_scene_node() -> void:
	var root := _make_scene("")  # never saved
	var child := Node.new()
	child.name = "Floating"
	root.add_child(child)

	var item := EppSelection.build_scene_item(child, root)
	_check("unsaved scene: id is null", item["id"] == null, str(item["id"]))
	_check("unsaved scene: path is null", item["path"] == null, str(item["path"]))
	_check("unsaved scene: label still present", item["label"] == "Floating", str(item["label"]))
	root.free()

func _test_resource_item() -> void:
	# A path with no backing file on disk: get_resource_uid must return
	# INVALID_ID, exercising the res://-path fallback rather than the
	# uid:// branch.
	var item := EppSelection.build_resource_item("res://Meshes/Rock.tres")
	_check("resource: kind", item["kind"] == "resource", str(item["kind"]))
	_check("resource: label is basename", item["label"] == "Rock.tres", str(item["label"]))
	_check("resource: path is workspace-relative", item["path"] == "Meshes/Rock.tres", str(item["path"]))
	_check(
		"resource: id falls back to res:// path form (no uid for a nonexistent file)",
		String(item["id"]) == "godot:v1:res://Meshes/Rock.tres",
		str(item["id"]),
	)

func _test_folder_item() -> void:
	var item := EppSelection.build_resource_item("res://Meshes/")
	_check("folder: kind", item["kind"] == "folder", str(item["kind"]))
	_check("folder: label is folder name", item["label"] == "Meshes", str(item["label"]))
	_check("folder: detail says folder", item["detail"] == "folder", str(item["detail"]))

func _test_deterministic_ordering_and_union() -> void:
	var root := _make_scene("res://Scenes/Arena.tscn")
	var b := Node.new()
	b.name = "B"
	root.add_child(b)
	var a := Node.new()
	a.name = "A"
	root.add_child(a)

	# Passed in B, A order — output must be sorted (A before B) regardless.
	var nodes: Array = [b, a]
	var paths := PackedStringArray(["res://Meshes/Rock.tres"])
	var items := EppSelection.build_items(nodes, root, paths)

	_check("union: 2 nodes + 1 resource = 3 items", items.size() == 3, str(items.size()))
	if items.size() >= 2:
		_check("ordering: A before B", items[0]["label"] == "A" and items[1]["label"] == "B",
			"%s, %s" % [items[0].get("label"), items[1].get("label")])
	if items.size() >= 3:
		_check("union: resource item present after nodes", items[2]["kind"] == "resource", str(items[2]))
	root.free()

func _test_invalid_node_skipped() -> void:
	var root := _make_scene("res://Scenes/Arena.tscn")
	var live := Node.new()
	live.name = "Live"
	root.add_child(live)
	var doomed := Node.new()
	doomed.name = "Doomed"
	# Deliberately NOT added as a child, and freed immediately, to simulate
	# "selected 100ms ago, deleted since" without touching the tree's own
	# child-removal signals.
	doomed.free()

	var items := EppSelection.build_items([doomed, live], root, PackedStringArray())
	_check(
		"invalid node is skipped without crashing the builder",
		items.size() == 1 and items[0]["label"] == "Live",
		str(items),
	)
	root.free()

func _test_cap_at_64() -> void:
	var root := _make_scene("res://Scenes/Arena.tscn")
	var nodes: Array = []
	for i in 80:
		var n := Node.new()
		n.name = "N%03d" % i
		root.add_child(n)
		nodes.append(n)

	var items := EppSelection.build_items(nodes, root, PackedStringArray())
	_check("cap: 80 selected nodes truncate to 64", items.size() == 64, str(items.size()))
	root.free()
