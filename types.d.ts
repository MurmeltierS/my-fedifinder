
declare module 'webfinger.js' {
    export default class WebFinger {
        constructor(options: {
            webfist_fallback: boolean,
            tls_only: boolean,
            uri_fallback: boolean,
            request_timeout: number
        });
        lookup(url: string, callback: (err: any, data: any) => void): void;
    }
}