import * as config from './config.json'
import {Hono} from 'hono'
import * as jose from 'jose'

const algorithm = {
    name: 'RSASSA-PKCS1-v1_5',
    modulusLength: 2048,
    publicExponent: new Uint8Array([0x01, 0x00, 0x01]),
    hash: {name: 'SHA-256'},
}

const importAlgo = {
    name: 'RSASSA-PKCS1-v1_5',
    hash: {name: 'SHA-256'},
}

async function loadOrGenerateKeyPair(KV) {
    let keyPair = {}
    let keyPairJson = await KV.get('keys', {type: 'json'})

    if (keyPairJson !== null) {
        keyPair.publicKey = await crypto.subtle.importKey('jwk', keyPairJson.publicKey, importAlgo, true, ['verify'])
        keyPair.privateKey = await crypto.subtle.importKey('jwk', keyPairJson.privateKey, importAlgo, true, ['sign'])

        return keyPair
    } else {
        keyPair = await crypto.subtle.generateKey(algorithm, true, ['sign', 'verify'])

        await KV.put('keys', JSON.stringify({
            privateKey: await crypto.subtle.exportKey('jwk', keyPair.privateKey),
            publicKey: await crypto.subtle.exportKey('jwk', keyPair.publicKey)
        }))

        return keyPair
    }

}

const app = new Hono()

app.get('/authorize/:scopemode', async (c) => {

    if (c.req.query('client_id') !== config.clientId
        || c.req.query('redirect_uri') !== config.redirectURL
        || !['guilds', 'email'].includes(c.req.param('scopemode'))) {
        return c.text('Bad request.', 400)
    }

    const params = new URLSearchParams({
        'client_id': config.clientId,
        'redirect_uri': config.redirectURL,
        'response_type': 'code',
        'scope': c.req.param('scopemode') == 'guilds' ? 'identify email guilds' : 'identify email',
        'state': c.req.query('state'),
        'prompt': 'none'
    }).toString()

    return c.redirect('https://discord.com/oauth2/authorize?' + params)
})

app.post('/token', async (c) => {
    const body = await c.req.parseBody()
    const code = body['code']
    const params = new URLSearchParams({
        'client_id': config.clientId,
        'client_secret': config.clientSecret,
        'redirect_uri': config.redirectURL,
        'code': code,
        'grant_type': 'authorization_code',
        'scope': 'identify email'
    }).toString()

    const r = await fetch('https://discord.com/api/oauth2/token', {
        method: 'POST',
        body: params,
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded'
        }
    }).then(res => res.json())

    if (r === null) return new Response("Bad request.", {status: 400})
    const userInfo = await fetch('https://discord.com/api/users/@me', {
        headers: {
            'Authorization': 'Bearer ' + r['access_token']
        }
    }).then(res => res.json())

    if (!userInfo['verified']) return c.text('Bad request.', 400)

    let servers = []

    const serverResp = await fetch('https://discord.com/api/users/@me/guilds', {
        headers: {
            'Authorization': 'Bearer ' + r['access_token']
        }
    })

    if (serverResp.status === 200) {
        const serverJson = await serverResp.json()
        servers = serverJson.map(item => {
            return item['id']
        })
    }

    let roleClaims = {}

    if (c.env.DISCORD_TOKEN && 'serversToCheckRolesFor' in config) {
        await Promise.all(config.serversToCheckRolesFor.map(async guildId => {
                if (servers.includes(guildId)) {
                    let memberPromise = fetch(`https://discord.com/api/guilds/${guildId}/members/${userInfo['id']}`, {
                        headers: {
                            'Authorization': 'Bot ' + c.env.DISCORD_TOKEN
                        }
                    })
                    // i had issues doing this any other way?
                    const memberResp = await memberPromise
                    const memberJson = await memberResp.json()

                    roleClaims[`roles:${guildId}`] = memberJson.roles
                }

            }
        ))
    }

    let email_verified = userInfo['verified']
    if (email_verified === false) {
        return new Response("Email not verified yet.", {status: 400})
    }


    let iat = Math.floor(Date.now() / 1000)

    let claim = {
        iss: config.issuerURL,
        aud: config.clientId,
        preferred_username: `${userInfo['username']}`,
        ...userInfo,
        ...roleClaims,
        email: userInfo['email'],
        email_verified: email_verified,
        name: `${userInfo['global_name']}`,
        iat: iat,
        guilds: servers,
        sub: userInfo['id'],
        picture: `https://cdn.discordapp.com/avatars/${userInfo['id']}/${userInfo['avatar']}.png`
    }

    const idToken = await new jose.SignJWT(claim)
        .setProtectedHeader({alg: 'RS256'})
        .setExpirationTime('1h')
        .setAudience(config.clientId)
        .sign((await loadOrGenerateKeyPair(c.env.KV)).privateKey)

    console.log(idToken)

    let res = {
        ...r,
        scope: 'identify email',
        id_token: idToken
    }

    console.log(res)

    return c.json(res)
})

app.get('/userinfo', async (c) => {
    const authHeader = c.req.headers.get('Authorization')
    if (!authHeader) return c.text('Unauthorized.', 401)

    const token = authHeader.split(' ')[1]

    const userInfo = await fetch('https://discord.com/api/users/@me', {
        headers: {
            'Authorization': 'Bearer ' + token
        }
    }).then(res => res.json())

    if (!userInfo['verified']) return c.text('Unauthorized.', 401)

    let servers = []

    const serverResp = await fetch('https://discord.com/api/users/@me/guilds', {
        headers: {
            'Authorization': 'Bearer ' + r['access_token']
        }
    })

    if (serverResp.status === 200) {
        const serverJson = await serverResp.json()
        servers = serverJson.map(item => {
            return item['id']
        })
    }

    let iat = Math.floor(Date.now() / 1000)

    let claim = {
        iss: config.issuerURL,
        aud: config.clientId,
        preferred_username: `${userInfo['username']}`,
        ...userInfo,
        email: userInfo['email'],
        email_verified: userInfo['verified'],
        name: `${userInfo['global_name']}`,
        iat: iat,
        guilds: servers,
        sub: userInfo['id'],
        picture: `https://cdn.discordapp.com/avatars/${userInfo['id']}/${userInfo['avatar']}.png`
    }

    return c.json(claim)

})

app.get('/jwks.json', async (c) => {
    let publicKey = (await loadOrGenerateKeyPair(c.env.KV)).publicKey
    return c.json({
        keys: [{
            alg: 'RS256',
            kid: 'jwtRS256',
            ...(await crypto.subtle.exportKey('jwk', publicKey))
        }]
    })
})

app.get('/.well-known/openid-configuration', async (c) => {
    return c.json({
        "issuer": config.issuerURL,
        "authorization_endpoint": config.issuerURL + "/authorize/guilds",
        "token_endpoint": config.issuerURL + "/token",
        "userinfo_endpoint": config.issuerURL + "/userinfo",
        "jwks_uri": config.issuerURL + "/jwks.json",
        "response_types_supported": [
            "code",
            "code id_token",
            "id_token",
            "token id_token"
        ],
        "subject_types_supported": [
            "public"
        ],
        "id_token_signing_alg_values_supported": [
            "RS256"
        ],
        "userinfo_signing_alg_values_supported": [
            "none"
        ],
        "request_object_signing_alg_values_supported": [
            "none"
        ],
        "scopes_supported": [
            "identify",
            "email",
            "guilds"
        ],
        "token_endpoint_auth_methods_supported": [
            // "client_secret_post",
            // "client_secret_basic",
            // "private_key_jwt"
            'client_secret_basic',
            'private_key_jwt'
        ],
        "token_endpoint_auth_signing_alg_values_supported": ['RS256'],
        "claims_supported": [
            "id",
            "email",
            "username",
            "guilds",
            "preferred_username",
            "avatar",
            "iss",
            "aud",
            "sub",
            "iat"
        ],
        "code_challenge_methods_supported": [
            "plain",
            "S256"
        ],
        "grant_types_supported": [
            // "none",
            "authorization_code",
            "refresh_token",
        ],
        "display_values_supported": [
            "page",
            "popup"
        ]
    })
})

export default app