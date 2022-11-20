// Copyright 2021 Twitter, Inc.
// SPDX-License-Identifier: Apache-2.0

import { Client, auth } from 'twitter-api-sdk';
import express from 'express';
import dotenv from 'dotenv';
import { components, TwitterResponse, usersIdFollowing } from 'twitter-api-sdk/dist/types';
import WebFinger from 'webfinger.js'

dotenv.config();

const webfinger = new WebFinger({
    webfist_fallback: false,
    tls_only: false,
    uri_fallback: true,
    request_timeout: 5000
})

const app = express();

const authClient = new auth.OAuth2User({
    client_id: process.env.CLIENT_ID as string,
    client_secret: process.env.CLIENT_SECRET as string,
    callback: `${process.env.HOST}/callback`,
    scopes: ['tweet.read', 'users.read', 'offline.access', 'follows.read'],
});

const client = new Client(authClient);

const STATE = 'my-state';

app.get('/callback', async function (req, res) {
    try {
        const { code, state } = req.query;
        if (state !== STATE) return res.status(500).send('State isn\'t matching');
        await authClient.requestAccessToken(code as string);
        res.redirect('/tweets');
    } catch (error) {
        console.log(error);
    }
});

app.get('/login', async function (req, res) {
    const authUrl = authClient.generateAuthURL({
        state: STATE,
        code_challenge_method: 'plain',
        code_challenge: 'test',
    });
    res.redirect(authUrl);
});

function nameFromUrl(urlstring: string) {
    // returns username without @
    let name = "";
    // https://host.tld/@name host.tld/web/@name/
    // not a proper domain host.tld/@name
    if (urlstring.includes("@"))
        name = urlstring
            .split(/\/|\?/)
            .filter((urlparts) => urlparts.includes("@"))[0]
            .replace("@", "");
    // friendica: sub.domain.tld/profile/name
    else if (urlstring.includes("/profile/"))
        name = urlstring.split("/profile/").slice(-1)[0].replace(/\/+$/, "");
    // diaspora: domain.tld/u/name
    else if (urlstring.includes("/u/"))
        name = urlstring.split("/u/").slice(-1)[0].replace(/\/+$/, "");
    // peertube: domain.tld/u/name
    else if (/\/c\/|\/a\//.test(urlstring))
        name = urlstring
            .split(/\/c\/|\/a\//)
            .slice(-1)[0]
            .split("/")[0];
    else {
        console.log(`didn't find name in ${urlstring}`);
    }
    return name;
}

function handleFromUrl(urlstring: string) {
    // transform an URL-like string into a fediverse handle: @name@server.tld
    let name = nameFromUrl(urlstring);
    if (urlstring.match(/^http/i)) {
        // proper url
        let handleUrl = new URL(urlstring);
        return `@${name}@${handleUrl.host}`;
    } else {
        // not a proper URL
        let domain = urlstring.split("/")[0];
        return `@${name}@${domain}`;
    }
}

function findHandles(text: string) {
    // split text into string and check them for handles

    // remove weird characters and unicode font stuff
    text = text
        .replace(/[^\p{L}\p{N}\p{P}\p{Z}\n@\.^$]/gu, " ")
        .toLowerCase()
        .normalize("NFKD");

    // different separators people use
    let words = text.split(/,|\s|“|#|\(|\)|'|》|\?|\n|\r|\t|・|\||…|\.\s|\s$/);

    // remove common false positives
    let unwanted_domains =
        /gmail\.com(?:$|\/)|mixcloud|linktr\.ee(?:$|\/)|pinboardxing\.com(?:$|\/)|researchgate|about|bit\.ly(?:$|\/)|imprint|impressum|patreon|donate|blog|facebook|news|github|instagram|t\.me(?:$|\/)|medium\.com(?:$|\/)|t\.co(?:$|\/)|tiktok\.com(?:$|\/)|youtube\.com(?:$|\/)|pronouns\.page(?:$|\/)|mail@|observablehq|twitter\.com(?:$|\/)|contact@|kontakt@|protonmail|traewelling\.de(?:$|\/)|press@|support@|info@|pobox|hey\.com(?:$|\/)/;
    words = words.filter((word) => !unwanted_domains.test(word));
    words = words.filter((w) => w);

    let handles: string[] = [];

    words.map((word) => {
        // @username@server.tld
        if (/^@[a-zA-Z0-9_]+@.+\.[a-zA-Z]+$/.test(word)) handles.push(word);
        // some people don't include the initial @
        else if (/^[a-zA-Z0-9_]+@.+\.[a-zA-Z|]+$/.test(word))
            handles.push(`@${word}`);
        // server.tld/@username
        // friendica: sub.domain.tld/profile/name
        else if (
            /^.+\.[a-zA-Z]+.*\/(@|web\/|profile\/|\/u\/|\/c\/)[a-zA-Z0-9_]+\/*$/.test(
                word
            )
        )
            handles.push(handleFromUrl(word));

        // experimental. domain.tld/name. too many false positives
        // pleroma, snusocial
        //else if (/^.+\.[a-zA-Z]+\/[a-zA-Z_]+\/?$/.test(word)) console.log(word);
    });
    return [...new Set(handles)];
}

function processUser(user: components['schemas']['User']) {
    let text = `${user.name} ${user.description} ${user.location} ${/*user['pinned_tweet_id']*/''} ${user.url}`
    let handles = findHandles(text)
    return handles
}

let i = 0;

async function checkUser (handle: string): Promise<boolean> {
    try {
        const handleWithoutLeadingAt = handle.replace(/^@/, '')
        const data: any = await new Promise((res, rej) => webfinger.lookup(handleWithoutLeadingAt, (err, d) => err ? rej(err) : res(d)))
        const exists = data?.object?.links?.some(link => link.rel === 'http://webfinger.net/rel/profile-page') ?? false
        i++
        console.log(i, { data })
        return exists
    } catch (error) {
        console.log('err')
        console.log(error)
        return false
    }
    return false
}

app.get('/tweets', async function (req, res) {
    try {
        const { data: me } = await client.users.findMyUser({ 'user.fields': ['id', 'username'] })
        if (!me) throw new Error('No user found')
        const { data: followings } = await client.users.usersIdFollowing(me.id, {
            max_results: 1000,
            expansions: ['pinned_tweet_id'],
            'user.fields': ['name', 'description', 'url', 'location', 'entities'],
            'tweet.fields': ['text', 'entities']
        })
        if (!followings) throw new Error('No followings found')
        const handles = followings.map(user => processUser(user)).flat()
        const uniqueHandles = [...new Set(handles)]
        const uniqueHandlesWithStatus = await Promise.all(uniqueHandles.map(async handle => ({ handle, exists: await checkUser(handle) })))
        res.send({ uniqueHandlesWithStatus });
    } catch (error) {
        console.log('tweets error', error);
    }
});

app.get('/revoke', async function (req, res) {
    try {
        const response = await authClient.revokeAccessToken();
        res.send(response);
    } catch (error) {
        console.log(error);
    }
});

app.get('/webfinger', async function(req, res) {
    try {
        console.log('letsgo')
        const data: any = await new Promise((res, rej) => webfinger.lookup(req.query.resource as string, (err, d) => err ? rej(err) : res(d)))
        const exists = data?.links?.some(link => link.rel === 'http://webfinger.net/rel/profile-page') ?? false
        res.send({ exists });
    } catch (error) {
        console.log('err');
        console.log(error);
        res.send({ err: 'Error' })
    }
})

app.listen(3000, () => {
    console.log(`Go here to login: ${process.env.HOST}/login`);
});
