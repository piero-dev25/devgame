import unittest

from epp import mapping


class MapGamePackagePathTests(unittest.TestCase):
    def test_game_mount_point_asset(self):
        self.assertEqual(
            mapping.map_game_package_path("/Game/Meshes/Rock", is_world=False),
            "Content/Meshes/Rock.uasset",
        )

    def test_game_mount_point_world(self):
        self.assertEqual(
            mapping.map_game_package_path("/Game/Maps/Arena", is_world=True),
            "Content/Maps/Arena.umap",
        )

    def test_non_game_mount_point_is_null(self):
        # A guessed path is worse than no path — path is precisely the
        # field an agent will act on.
        self.assertIsNone(mapping.map_game_package_path("/Engine/BasicShapes/Cube", is_world=False))
        self.assertIsNone(mapping.map_game_package_path("/SomePlugin/Foo", is_world=False))

    def test_none_and_empty_input(self):
        self.assertIsNone(mapping.map_game_package_path(None, is_world=False))
        self.assertIsNone(mapping.map_game_package_path("", is_world=False))
        self.assertIsNone(mapping.map_game_package_path("/Game/", is_world=False))


class BuildActorItemTests(unittest.TestCase):
    def _base_kwargs(self, **overrides):
        kwargs = dict(
            path_name="/Game/Maps/Arena.Arena:PersistentLevel.PlayerRoot_C_1",
            is_pie=False,
            label="PlayerRoot",
            fallback_name="PlayerRoot_C_1",
            level_package_name="/Game/Maps/Arena",
            level_display_name="Arena",
            folder_path="Systems",
            class_name="PlayerRoot_C",
            is_blueprint_class=True,
        )
        kwargs.update(overrides)
        return kwargs

    def test_normal_actor(self):
        item = mapping.build_actor_item(**self._base_kwargs())
        self.assertEqual(item.kind, "actor")
        self.assertEqual(item.id, "/Game/Maps/Arena.Arena:PersistentLevel.PlayerRoot_C_1")
        self.assertEqual(item.label, "PlayerRoot")
        self.assertEqual(item.path, "Content/Maps/Arena.umap")
        self.assertEqual(item.detail, "Arena / Systems · Blueprint")

    def test_pie_actor_has_null_id_but_keeps_label_and_detail(self):
        item = mapping.build_actor_item(**self._base_kwargs(is_pie=True))
        self.assertIsNone(item.id)
        self.assertEqual(item.label, "PlayerRoot")  # still true and useful
        self.assertIsNotNone(item.detail)

    def test_label_falls_back_to_internal_name_then_placeholder(self):
        item = mapping.build_actor_item(**self._base_kwargs(label=None))
        self.assertEqual(item.label, "PlayerRoot_C_1")

        item2 = mapping.build_actor_item(**self._base_kwargs(label=None, fallback_name=None))
        self.assertEqual(item2.label, "(unnamed actor)")

    def test_label_falls_back_when_blank_string(self):
        item = mapping.build_actor_item(**self._base_kwargs(label="   ", fallback_name="Fallback"))
        self.assertEqual(item.label, "Fallback")

    def test_detail_folder_path_form(self):
        item = mapping.build_actor_item(**self._base_kwargs(folder_path="Systems/Gameplay", is_blueprint_class=False))
        self.assertEqual(item.detail, "Arena / Systems/Gameplay")

    def test_detail_falls_back_to_class_name_when_no_folder(self):
        item = mapping.build_actor_item(**self._base_kwargs(folder_path=None, is_blueprint_class=False))
        self.assertEqual(item.detail, "Arena · PlayerRoot_C")

    def test_detail_falls_back_to_level_name_only(self):
        item = mapping.build_actor_item(
            **self._base_kwargs(folder_path=None, class_name=None, is_blueprint_class=False)
        )
        self.assertEqual(item.detail, "Arena")

    def test_detail_is_none_when_level_name_unavailable(self):
        item = mapping.build_actor_item(**self._base_kwargs(level_display_name=None))
        self.assertIsNone(item.detail)

    def test_actor_path_uses_level_umap_not_actor_soft_path(self):
        item = mapping.build_actor_item(**self._base_kwargs())
        self.assertEqual(item.path, "Content/Maps/Arena.umap")
        self.assertNotIn("PlayerRoot", item.path)

    def test_non_game_level_mount_point_gives_null_path(self):
        item = mapping.build_actor_item(**self._base_kwargs(level_package_name="/SomePlugin/Maps/Foo"))
        self.assertIsNone(item.path)

    def test_missing_path_name_gives_null_id(self):
        item = mapping.build_actor_item(**self._base_kwargs(path_name=None))
        self.assertIsNone(item.id)


class BuildAssetItemTests(unittest.TestCase):
    def test_normal_asset(self):
        item = mapping.build_asset_item(
            package_name="/Game/Meshes/Rock", asset_name="Rock", asset_class="StaticMesh", is_world_class=False
        )
        self.assertEqual(item.kind, "asset")
        self.assertEqual(item.id, "/Game/Meshes/Rock.Rock")
        self.assertEqual(item.label, "Rock")
        self.assertEqual(item.path, "Content/Meshes/Rock.uasset")
        self.assertEqual(item.detail, "StaticMesh")

    def test_world_asset_gets_umap_extension(self):
        item = mapping.build_asset_item(
            package_name="/Game/Maps/Arena", asset_name="Arena", asset_class="World", is_world_class=True
        )
        self.assertEqual(item.path, "Content/Maps/Arena.umap")

    def test_missing_package_or_name_gives_null_id(self):
        item = mapping.build_asset_item(package_name=None, asset_name="Rock", asset_class=None, is_world_class=False)
        self.assertIsNone(item.id)
        item2 = mapping.build_asset_item(package_name="/Game/X", asset_name=None, asset_class=None, is_world_class=False)
        self.assertIsNone(item2.id)

    def test_label_fallback_when_asset_name_missing(self):
        item = mapping.build_asset_item(package_name="/Game/X", asset_name=None, asset_class=None, is_world_class=False)
        self.assertEqual(item.label, "(unnamed asset)")

    def test_non_game_mount_point_asset_path_is_null(self):
        item = mapping.build_asset_item(
            package_name="/Engine/BasicShapes/Cube", asset_name="Cube", asset_class="StaticMesh", is_world_class=False
        )
        self.assertIsNone(item.path)


class OrderItemsTests(unittest.TestCase):
    def test_actors_before_assets(self):
        actor = mapping.build_actor_item(
            path_name="/Game/Maps/A.A:PersistentLevel.X",
            is_pie=False,
            label="X",
            fallback_name=None,
            level_package_name="/Game/Maps/A",
            level_display_name="A",
            folder_path=None,
            class_name=None,
            is_blueprint_class=False,
        )
        asset = mapping.build_asset_item(
            package_name="/Game/Meshes/Rock", asset_name="Rock", asset_class="StaticMesh", is_world_class=False
        )
        ordered = mapping.order_items([asset, asset], [actor])  # deliberately passed "wrong" to prove no reordering within groups happens implicitly
        # order_items only concatenates actor-list then asset-list; caller
        # is responsible for each list's own internal order.
        self.assertEqual(ordered, [asset, asset, actor])

        ordered2 = mapping.order_items([actor], [asset])
        self.assertEqual(ordered2, [actor, asset])


if __name__ == "__main__":
    unittest.main()
