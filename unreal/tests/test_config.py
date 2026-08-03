import os
import shutil
import tempfile
import unittest

from epp import config


class ResolveTokenTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _token_file(self, contents):
        path = os.path.join(self.tmp, "token.txt")
        with open(path, "w", encoding="utf-8") as f:
            f.write(contents)
        return path

    def test_env_var_wins_over_file(self):
        path = self._token_file("file-token\n")
        token = config.resolve_token(env={config.TOKEN_ENV_VAR: "env-token"}, token_file_path=path)
        self.assertEqual(token, "env-token")

    def test_falls_back_to_file_when_env_absent(self):
        path = self._token_file("file-token\n")
        token = config.resolve_token(env={}, token_file_path=path)
        self.assertEqual(token, "file-token")

    def test_blank_env_var_falls_through_to_file(self):
        path = self._token_file("file-token\n")
        token = config.resolve_token(env={config.TOKEN_ENV_VAR: "   "}, token_file_path=path)
        self.assertEqual(token, "file-token")

    def test_file_first_non_empty_line(self):
        path = self._token_file("\n\n  \nreal-token\nsecond-line\n")
        token = config.resolve_token(env={}, token_file_path=path)
        self.assertEqual(token, "real-token")

    def test_missing_file_returns_none(self):
        token = config.resolve_token(env={}, token_file_path=os.path.join(self.tmp, "missing.txt"))
        self.assertIsNone(token)

    def test_no_file_path_given_returns_none(self):
        token = config.resolve_token(env={}, token_file_path=None)
        self.assertIsNone(token)


class ResolveWsUrlTests(unittest.TestCase):
    def test_default_when_env_absent(self):
        self.assertEqual(config.resolve_ws_url(env={}), config.DEFAULT_WS_URL)

    def test_env_override(self):
        custom = "ws://10.0.0.5:9999/editor-presence?role=publisher"
        self.assertEqual(config.resolve_ws_url(env={config.URL_ENV_VAR: custom}), custom)


class WsUrlToHttpBaseTests(unittest.TestCase):
    def test_ws_to_http(self):
        self.assertEqual(config.ws_url_to_http_base("ws://127.0.0.1:3777/editor-presence?role=publisher"), "http://127.0.0.1:3777")

    def test_wss_to_https(self):
        self.assertEqual(config.ws_url_to_http_base("wss://example.com/editor-presence?role=publisher"), "https://example.com")


class ExtractPairingCredentialTests(unittest.TestCase):
    def test_bare_credential(self):
        self.assertEqual(config.extract_pairing_credential("  abc123  "), "abc123")

    def test_url_with_fragment_token(self):
        url = "http://127.0.0.1:3777/pair#token=abc%20123"
        self.assertEqual(config.extract_pairing_credential(url), "abc 123")

    def test_url_with_query_and_ampersand_stops_at_boundary(self):
        pasted = "token=abc123&other=xyz"
        self.assertEqual(config.extract_pairing_credential(pasted), "abc123")

    def test_empty_input(self):
        self.assertEqual(config.extract_pairing_credential(""), "")
        self.assertEqual(config.extract_pairing_credential(None), "")


class RedeemPairingCredentialTests(unittest.TestCase):
    def test_posts_exact_field_set_matching_auth_ts_contract(self):
        captured = {}

        def fake_http_post(url, fields, timeout_s):
            captured["url"] = url
            captured["fields"] = fields
            captured["timeout_s"] = timeout_s
            return {"access_token": "redeemed-token-xyz"}

        token = config.redeem_pairing_credential(
            "pairing-cred-123", base_http_url="http://127.0.0.1:3777/", http_post=fake_http_post
        )
        self.assertEqual(token, "redeemed-token-xyz")
        self.assertEqual(captured["url"], "http://127.0.0.1:3777/oauth/token")
        self.assertEqual(
            captured["fields"],
            {
                "grant_type": "urn:ietf:params:oauth:grant-type:token-exchange",
                "subject_token": "pairing-cred-123",
                "subject_token_type": "urn:t3:params:oauth:token-type:environment-bootstrap",
                "requested_token_type": "urn:ietf:params:oauth:token-type:access_token",
                "client_label": "Unreal Editor",
            },
        )

    def test_empty_credential_raises_without_a_network_call(self):
        def fake_http_post(*_args, **_kwargs):
            raise AssertionError("should not be called for an empty credential")

        with self.assertRaises(config.RedeemError):
            config.redeem_pairing_credential("   ", base_http_url="http://x", http_post=fake_http_post)

    def test_missing_access_token_in_response_raises(self):
        def fake_http_post(*_args, **_kwargs):
            return {"token_type": "Bearer"}

        with self.assertRaises(config.RedeemError):
            config.redeem_pairing_credential("cred", base_http_url="http://x", http_post=fake_http_post)

    def test_http_post_exception_is_wrapped_in_redeem_error(self):
        def fake_http_post(*_args, **_kwargs):
            raise ConnectionRefusedError("nope")

        with self.assertRaises(config.RedeemError):
            config.redeem_pairing_credential("cred", base_http_url="http://x", http_post=fake_http_post)


class TokenFileRoundTripTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_write_then_read(self):
        config.write_token_file(self.tmp, "  some-token  ")
        self.assertEqual(config.read_token_file_raw(self.tmp), "some-token")

    def test_read_missing_file_returns_empty_string(self):
        self.assertEqual(config.read_token_file_raw(self.tmp), "")

    def test_write_creates_parent_directories(self):
        path = config.write_token_file(self.tmp, "tok")
        self.assertTrue(os.path.isfile(path))
        self.assertEqual(os.path.dirname(path), os.path.join(self.tmp, "Saved", "EditorPresence"))


class RedeemAndStoreFromTokenFileTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_happy_path_overwrites_file_with_bearer_token(self):
        config.write_token_file(self.tmp, "pairing-credential-from-t3-pair")

        def fake_http_post(url, fields, timeout_s):
            self.assertEqual(fields["subject_token"], "pairing-credential-from-t3-pair")
            return {"access_token": "long-lived-bearer-token"}

        result = config.redeem_and_store_from_token_file(self.tmp, base_http_url="http://127.0.0.1:3777", http_post=fake_http_post)
        self.assertEqual(result, "long-lived-bearer-token")
        self.assertEqual(config.read_token_file_raw(self.tmp), "long-lived-bearer-token")

    def test_empty_token_file_raises_without_leaving_it_modified(self):
        with self.assertRaises(config.RedeemError):
            config.redeem_and_store_from_token_file(self.tmp, base_http_url="http://x", http_post=lambda *a, **k: {})
        self.assertEqual(config.read_token_file_raw(self.tmp), "")

    def test_failed_redeem_leaves_original_file_content_untouched(self):
        config.write_token_file(self.tmp, "bad-credential")

        def failing_http_post(*_args, **_kwargs):
            raise ConnectionRefusedError("server down")

        with self.assertRaises(config.RedeemError):
            config.redeem_and_store_from_token_file(self.tmp, base_http_url="http://x", http_post=failing_http_post)
        self.assertEqual(config.read_token_file_raw(self.tmp), "bad-credential")


if __name__ == "__main__":
    unittest.main()
