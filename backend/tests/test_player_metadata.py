from services.resolver import _build_resolve_response


def test_resolve_preserves_channel_and_uses_uploader_when_channel_missing():
    stream = {'url': 'https://cdn.test/video.mp4'}
    for info, expected in [({'channel': 'Channel', 'uploader': 'Uploader'}, 'Channel'),
                           ({'uploader': 'Uploader'}, 'Uploader'), ({}, None)]:
        result = _build_resolve_response('https://example.com/video', info, stream)
        assert result['channel'] == expected
