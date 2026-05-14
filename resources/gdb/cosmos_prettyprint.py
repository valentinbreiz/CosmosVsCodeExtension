# Pretty-printers for NativeAOT managed types in the Cosmos kernel.
#
# NativeAOT emits DWARF DW_TAG_class_type entries for managed types, so gdb
# already knows the field layout (String._stringLength, __Array<T>.m_Data, etc).
# These printers render those layouts as C# values rather than raw structs.

import gdb


def _read_utf16(addr, length):
    if length <= 0:
        return ""
    inferior = gdb.selected_inferior()
    raw = bytes(inferior.read_memory(addr, length * 2))
    try:
        return raw.decode("utf-16-le", errors="replace")
    except Exception:
        return "<undecodable>"


class StringPrinter:
    """System.String: render as a quoted UTF-16 literal."""

    def __init__(self, val):
        self.val = val

    def to_string(self):
        try:
            v = self.val.dereference() if self.val.type.code == gdb.TYPE_CODE_PTR else self.val
            length = int(v["_stringLength"])
            first_char_addr = int(v["_firstChar"].address)
            return _read_utf16(first_char_addr, length)
        except gdb.MemoryError:
            return "<unreadable string>"
        except Exception as e:
            return "<String: {}>".format(e)

    def display_hint(self):
        return "string"


class ArrayPrinter:
    """NativeAOT managed arrays: render Length + element iterator."""

    def __init__(self, val):
        self.val = val

    def _array(self):
        return self.val.dereference() if self.val.type.code == gdb.TYPE_CODE_PTR else self.val

    def to_string(self):
        try:
            n = int(self._array()["m_NumComponents"])
            return "Length = {}".format(n)
        except Exception:
            return "<array>"

    def children(self):
        try:
            arr = self._array()
            n = int(arr["m_NumComponents"])
            data = arr["m_Data"]
            for i in range(n):
                yield ("[{}]".format(i), data[i])
        except Exception:
            return

    def display_hint(self):
        return "array"


class ObjectPrinter:
    """System.Object: surface the MethodTable* address so users can chase types.

    A future iteration will resolve m_pEEType -> dynamic type name via a
    build-time address map and downcast accordingly.
    """

    def __init__(self, val):
        self.val = val

    def to_string(self):
        try:
            v = self.val.dereference() if self.val.type.code == gdb.TYPE_CODE_PTR else self.val
            mt = int(v["m_pEEType"])
            return "Object {{ MethodTable = 0x{:016x} }}".format(mt)
        except Exception:
            return "<Object>"


def _strip_ref_ptr(t):
    while t.code in (gdb.TYPE_CODE_REF, gdb.TYPE_CODE_PTR):
        t = t.target()
    return t


def cosmos_lookup(val):
    try:
        t = _strip_ref_ptr(val.type).unqualified()
    except Exception:
        return None
    name = t.name or ""
    if name == "String":
        return StringPrinter(val)
    if name == "Object":
        return ObjectPrinter(val)
    if name.startswith("__Array<"):
        return ArrayPrinter(val)
    return None


def register():
    gdb.pretty_printers.append(cosmos_lookup)


register()
