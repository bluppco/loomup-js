package com.loomup.client

import kotlinx.coroutines.runBlocking
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

class AuthRefreshTest {
    @Test
    fun on401RefreshesOnceAndRetries() = runBlocking {
        val http = MockHttp()
        var access = "old-access"
        http.handler = { _, url, auth, _ ->
            when {
                url.endsWith("/auth/refresh") -> {
                    access = "new-access"
                    val body = """
                        {
                          "data": {
                            "access_token": "$access",
                            "refresh_token": "refresh-2",
                            "token_type": "Bearer",
                            "expires_in": 900
                          }
                        }
                    """.trimIndent()
                    jsonBytes(body) to 200
                }
                url.endsWith("/auth/me") -> {
                    when (auth) {
                        "Bearer old-access" -> {
                            jsonBytes("""{"error":{"code":"unauthorized","message":"expired"}}""") to 401
                        }
                        "Bearer new-access" -> {
                            val body = """
                                {
                                  "data": {
                                    "id": "u1",
                                    "email": "a@b.com",
                                    "role": "user",
                                    "disabled": false,
                                    "created_at": 1
                                  }
                                }
                            """.trimIndent()
                            jsonBytes(body) to 200
                        }
                        else -> jsonBytes("nope") to 404
                    }
                }
                else -> jsonBytes("not found") to 404
            }
        }

        val c = createClient(
            url = "http://example.test",
            token = "old-access",
            refreshToken = "refresh-1",
            http = http,
        )
        val me = c.me()
        assertEquals("a@b.com", me.email)
        assertEquals("new-access", c.accessToken)
        val calls = http.snapshotCalls()
        assertTrue(calls.any { it.url.endsWith("/auth/refresh") })
        val meCalls = calls.filter { it.url.endsWith("/auth/me") }
        assertEquals(2, meCalls.size)
        assertEquals("Bearer old-access", meCalls[0].auth)
        assertEquals("Bearer new-access", meCalls[1].auth)
    }

    @Test
    fun manualRefreshUpdatesTokens() = runBlocking {
        val http = MockHttp()
        http.handler = { _, url, _, _ ->
            if (url.endsWith("/auth/refresh")) {
                val body = """
                    {
                      "data": {
                        "access_token": "a2",
                        "refresh_token": "r2",
                        "token_type": "Bearer",
                        "expires_in": 60
                      }
                    }
                """.trimIndent()
                jsonBytes(body) to 200
            } else {
                jsonBytes("nope") to 500
            }
        }
        val c = createClient(
            url = "http://example.test",
            refreshToken = "r1",
            http = http,
        )
        val tokens = c.refresh()
        assertEquals("a2", tokens.accessToken)
        assertEquals("a2", c.accessToken)
    }

    @Test
    fun refreshWithoutTokenThrows() = runBlocking {
        val c = createClient(url = "http://example.test")
        val e = assertFailsWith<LoomupError> {
            c.refresh()
        }
        assertEquals("no_refresh", e.code)
    }
}
