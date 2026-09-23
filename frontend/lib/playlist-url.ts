/** Recognize YouTube playlist links without treating a watch link as a playlist by default. */
export function youtubePlaylistUrl(value: string): { hasPlaylist: boolean; purePlaylist: boolean } {
    try {
        const url = new URL(value);
        if (url.protocol !== 'http:' && url.protocol !== 'https:') return { hasPlaylist: false, purePlaylist: false };
        const host = url.hostname.toLowerCase();
        const youtube = [
            'youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com',
            'youtube-nocookie.com', 'www.youtube-nocookie.com', 'youtu.be', 'www.youtu.be',
        ].includes(host);
        const list = url.searchParams.get('list');
        if (!youtube || !list || !/^[A-Za-z0-9_-]{1,120}$/.test(list)) {
            return { hasPlaylist: false, purePlaylist: false };
        }
        const purePlaylist = url.pathname === '/playlist';
        return { hasPlaylist: true, purePlaylist };
    } catch {
        return { hasPlaylist: false, purePlaylist: false };
    }
}
