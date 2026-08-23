package com.loomup.client

import kotlinx.coroutines.runBlocking
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

class ClientTest {
    @Test
    fun createClientStoresUrlAndToken() {
        val c = createClient(
            url = "http://localhost:3000/",
            token = "abc",
        )
        assertEquals("http://localhost:3000", c.url)
        assertEquals("abc", c.accessToken)
    }

    @Test
    fun fromReturnsQueryMethods() {
        val c = createClient(url = "http://127.0.0.1:3000")
        val q = c.from("todos")
        assertNotNull(q)
        assertNotNull(c.auth)
    }

    @Test
    fun loomupErrorCarriesCode() {
        val e = LoomupError("nope", code = "forbidden", status = 403)
        assertEquals("forbidden", e.code)
        assertEquals(403, e.status)
        assertEquals("nope", e.message)
    }

    @Test
    fun selectEncodesBooleanWhereAsZeroOne() = runBlocking {
        val http = MockHttp()
        val urls = mutableListOf<String>()
        http.handler = { _, url, _, _ ->
            urls.add(url)
            val body = """{"data":[],"meta":{"limit":10,"offset":0,"total":0}}"""
            jsonBytes(body) to 200
        }
        val c = createClient(url = "http://localhost:3000", http = http)
        c.from("todos").select(where = mapOf("completed" to WhereValue.Bool(true)), limit = 5)
        assertTrue(
            urls[0].contains("where%5Bcompleted%5D=1") || urls[0].contains("where[completed]=1"),
            urls[0],
        )
        urls.clear()
        c.from("todos").select(where = mapOf("completed" to WhereValue.Bool(false)))
        assertTrue(
            urls[0].contains("where%5Bcompleted%5D=0") || urls[0].contains("where[completed]=0"),
            urls[0],
        )
    }

    @Test
    fun restOnlyDoesNotRequireWebSocket() = runBlocking {
        val http = MockHttp()
        http.handler = { _, url, _, _ ->
            if (url.endsWith("/auth/login")) {
                val body = """
                    {
                      "data": {
                        "access_token": "a",
                        "refresh_token": "r",
                        "token_type": "Bearer",
                        "expires_in": 60,
                        "user": {
                          "id": "u1",
                          "email": "a@b.com",
                          "role": "user",
                          "disabled": false,
                          "created_at": 1
                        }
                      }
                    }
                """.trimIndent()
                jsonBytes(body) to 200
            } else {
                jsonBytes("nope") to 404
            }
        }
        val c = createClient(url = "http://example.test", http = http)
        val tokens = c.signIn(email = "a@b.com", password = "secret12")
        assertEquals("a", tokens.accessToken)
        assertEquals("a", c.accessToken)
    }

    @Test
    fun crudInsertUpdateDeletePaths() = runBlocking {
        val http = MockHttp()
        http.handler = { method, url, _, body ->
            when {
                method == "POST" && url.endsWith("/api/todos") -> {
                    assertNotNull(body)
                    jsonBytes("""{"data":{"id":1,"title":"hi"}}""") to 200
                }
                method == "PATCH" && url.contains("/api/todos/1") -> {
                    jsonBytes("""{"data":{"id":1,"title":"bye"}}""") to 200
                }
                method == "DELETE" && url.contains("/api/todos/1") -> {
                    jsonBytes("""{"data":{"id":1,"title":"bye"}}""") to 200
                }
                method == "GET" && url.endsWith("/api/todos/1") -> {
                    jsonBytes("""{"data":{"id":1,"title":"hi"}}""") to 200
                }
                else -> jsonBytes("nope") to 404
            }
        }
        val c = createClient(url = "http://example.test", http = http)
        val inserted = c.from("todos").insert(
            mapOf(
                "title" to JsonValue.String("hi"),
                "completed" to JsonValue.Number(0.0),
            ),
        )
        assertEquals("hi", inserted["title"]?.stringValue)
        val got = c.from("todos").get(1)
        assertEquals(1, got["id"]?.intValue)
        val updated = c.from("todos").update(1, mapOf("title" to JsonValue.String("bye")))
        assertEquals("bye", updated["title"]?.stringValue)
        val deleted = c.from("todos").delete(1)
        assertEquals(1, deleted["id"]?.intValue)
    }
}
