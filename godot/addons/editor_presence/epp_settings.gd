@tool
extends RefCounted
class_name EppSettings

## EditorSettings (editor-global, not per-project) read/write for the
## addon's configuration — never ProjectSettings, which writes
## project.godot and would leak a bearer token into the user's repo. This
## is the Godot analogue of Unity's EditorPrefs.
##
## Consequence, stated rather than hidden: one token covers every Godot
## project opened in this editor install. Cross-project chip bleed is
## prevented only by the client-side workspace.root matching (see
## docs/workbench/spec-editor-presence.md step 3) — this addon contributes
## workspace.root and nothing else.

const SETTING_TOKEN := "workbench/editor_presence/token"
const SETTING_URL := "workbench/editor_presence/url"
const SETTING_INCLUDE_FILESYSTEM := "workbench/editor_presence/include_filesystem_selection"
const SETTING_ENABLED := "workbench/editor_presence/enabled"

const DEFAULT_URL := "ws://127.0.0.1:3777/editor-presence"

static func register_defaults(editor_settings: EditorSettings) -> void:
	_ensure(editor_settings, SETTING_TOKEN, "", TYPE_STRING, PROPERTY_HINT_PASSWORD)
	_ensure(editor_settings, SETTING_URL, DEFAULT_URL, TYPE_STRING)
	_ensure(editor_settings, SETTING_INCLUDE_FILESYSTEM, true, TYPE_BOOL)
	_ensure(editor_settings, SETTING_ENABLED, true, TYPE_BOOL)

static func get_token(editor_settings: EditorSettings) -> String:
	return String(editor_settings.get_setting(SETTING_TOKEN))

static func get_url(editor_settings: EditorSettings) -> String:
	var url := String(editor_settings.get_setting(SETTING_URL))
	return url if url != "" else DEFAULT_URL

static func get_include_filesystem(editor_settings: EditorSettings) -> bool:
	return bool(editor_settings.get_setting(SETTING_INCLUDE_FILESYSTEM))

static func get_enabled(editor_settings: EditorSettings) -> bool:
	return bool(editor_settings.get_setting(SETTING_ENABLED))

static func _ensure(
	editor_settings: EditorSettings,
	key: String,
	default_value: Variant,
	type: int,
	hint: int = PROPERTY_HINT_NONE,
) -> void:
	if not editor_settings.has_setting(key):
		editor_settings.set_setting(key, default_value)
	editor_settings.set_initial_value(key, default_value, false)
	editor_settings.add_property_info({
		"name": key,
		"type": type,
		"hint": hint,
	})
