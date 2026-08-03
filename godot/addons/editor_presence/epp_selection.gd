@tool
extends RefCounted
class_name EppSelection

## Builds Editor Presence Protocol items[] from engine objects.
##
## PURE: every function here takes plain engine objects (Node, path
## strings) as arguments rather than reaching into EditorInterface itself.
## That is the whole reason this file is separate from plugin.gd — a Node
## can be constructed and inspected in a headless SceneTree script
## (`Node.new()`), so this module's output is provable with
## `godot --headless --script <test>.gd` and a fake selection, with no
## editor running. Only plugin.gd touches EditorInterface to get the REAL
## selection; that binding itself stays unverified until the editor runs
## (see godot/addons/editor_presence/README.md).
##
## Field mapping matches the Unity package's shape (see
## unity/com.ironmind.editor-presence/Editor/EditorPresenceItemBuilder.cs)
## as closely as Godot's API allows; see docs/workbench/spec-godot-publisher.md
## step 2 for the full rationale on identity durability.

const MAX_ITEMS := 64

## Anchors a node to the currently edited scene root and returns an item
## dict. `scene_root` is `EditorInterface.get_edited_scene_root()` in real
## use; a test passes any Node it likes, including `node` itself.
## `id` is null when the scene has never been saved
## (`scene_root.scene_file_path == ""`) — an unsaved scene has no
## UID-based or path-based identity at all in Godot.
static func build_scene_item(node: Node, scene_root: Node) -> Dictionary:
	var rel_path := "."
	if scene_root != node:
		rel_path = String(scene_root.get_path_to(node))

	var id: Variant = null
	var scene_file: String = scene_root.scene_file_path
	if scene_file != "":
		var anchor := _resolve_uid_or_path(scene_file)
		id = "godot:v1:%s#%s" % [anchor, rel_path]

	var path: Variant = null
	if scene_file != "":
		path = _workspace_relative(scene_file)

	return {
		"id": id,
		"kind": "node",
		"label": String(node.name),
		"path": path,
		"detail": _build_node_detail(node, scene_root, rel_path),
	}

## Resource/folder items from the FileSystem dock's polled selection.
static func build_resource_item(res_path: String) -> Dictionary:
	var is_folder := res_path.ends_with("/")
	var trimmed := res_path.trim_suffix("/") if is_folder else res_path

	var id: Variant = null
	var uid := ResourceLoader.get_resource_uid(trimmed) if not is_folder else ResourceUID.INVALID_ID
	if uid != ResourceUID.INVALID_ID:
		id = ResourceUID.id_to_text(uid)
	else:
		id = "godot:v1:%s" % trimmed

	var label := trimmed.get_file()
	if label == "":
		# Root-level folder ("res://") — get_file() returns "" for it.
		label = trimmed

	var detail: String
	if is_folder:
		detail = "folder"
	else:
		# ResourceLoader has no header-only "get the type without loading"
		# call in this API (verified: ClassDB.class_get_method_list only
		# lists exists/get_resource_uid/get_recognized_extensions_for_type
		# — the spec's assumed get_resource_type() does not exist here).
		# Actually loading the resource to ask its class would work but
		# means a real load on a poll tick, which is exactly what this was
		# meant to avoid — so this uses the file extension, which is free.
		var extension := trimmed.get_extension()
		var dir := trimmed.get_base_dir().trim_prefix("res://")
		detail = "%s · %s" % [extension, dir] if dir != "" else extension

	return {
		"id": id,
		"kind": "folder" if is_folder else "resource",
		"label": label,
		"path": _workspace_relative(trimmed),
		"detail": detail,
	}

## Combines the scene-node selection and the FileSystem-dock selection into
## one EPP `items[]` array: scene nodes first (already the caller's order,
## expected pre-sorted — see `sort_key_for_node`), then filesystem paths,
## deterministically sorted, capped at MAX_ITEMS. This is the union rule
## from spec-godot-publisher.md step 3 — Godot's two selections never clear
## each other, so EPP gets told about both rather than picking one.
static func build_items(
	nodes: Array,
	scene_root: Node,
	paths: PackedStringArray,
) -> Array[Dictionary]:
	var items: Array[Dictionary] = []

	# Filter BEFORE sorting, not after: sort_custom's own argument marshaling
	# errors on a freed Object before a comparator's is_instance_valid()
	# check ever gets to run (observed — a headless test with one freed
	# node in the input produced an engine-level "Cannot convert argument"
	# error even though the comparator itself guards on validity). A node
	# selected 100ms ago, before this runs, is a real and not theoretical
	# case given the debounce.
	var live_nodes: Array = []
	for node in nodes:
		if is_instance_valid(node):
			live_nodes.append(node)
	live_nodes.sort_custom(
		func(a: Node, b: Node) -> bool:
			return sort_key_for_node(a, scene_root) < sort_key_for_node(b, scene_root)
	)
	for node in live_nodes:
		items.append(build_scene_item(node, scene_root))
		if items.size() >= MAX_ITEMS:
			return items

	var sorted_paths := paths.duplicate()
	sorted_paths.sort()
	for res_path in sorted_paths:
		items.append(build_resource_item(res_path))
		if items.size() >= MAX_ITEMS:
			break

	return items

## Sort key so multi-select order is deterministic (anchor path string) —
## `get_selected_nodes()` order is not documented as tree order.
static func sort_key_for_node(node: Node, scene_root: Node) -> String:
	if not is_instance_valid(node):
		return ""
	if scene_root == node:
		return "."
	return String(scene_root.get_path_to(node))

static func _resolve_uid_or_path(scene_file: String) -> String:
	var uid := ResourceLoader.get_resource_uid(scene_file)
	if uid != ResourceUID.INVALID_ID:
		return ResourceUID.id_to_text(uid)
	return scene_file

static func _workspace_relative(res_path: String) -> String:
	# workspace.root is the globalized "res://" (see plugin.gd); a res://
	# path is already workspace-relative once the prefix is stripped, same
	# shape as Unity emitting "Assets/Scenes/Arena.unity".
	return res_path.trim_prefix("res://")

static func _build_node_detail(node: Node, scene_root: Node, rel_path: String) -> String:
	var class_label := node.get_class()
	var script := node.get_script()
	if script != null and script.has_method("get_global_name"):
		var global_name: String = script.get_global_name()
		if global_name != "":
			class_label = global_name

	var hierarchy: String = String(scene_root.name)
	if rel_path != ".":
		hierarchy += " / " + rel_path.replace("/", " / ")

	return "%s · %s" % [class_label, hierarchy]
