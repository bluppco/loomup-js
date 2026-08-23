package com.loomup.client

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class SubKeyTest {
    @Test
    fun parseSubKeySplitsOnlyOnFirstHash() {
        val a = parseSubKey("todos")
        assertEquals("todos", a.first)
        assertNull(a.second)

        val b = parseSubKey("todos#1")
        assertEquals("todos", b.first)
        assertEquals("1", b.second)

        val c = parseSubKey("todos#a#b#c")
        assertEquals("todos", c.first)
        assertEquals("a#b#c", c.second)

        assertEquals("todos#a#b", makeSubKey("todos", "a#b"))
        val round = parseSubKey(makeSubKey("notes", "x#y"))
        assertEquals("notes", round.first)
        assertEquals("x#y", round.second)
    }
}
