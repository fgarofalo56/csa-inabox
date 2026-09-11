"""Static JVM link check for a netty jar swap inside a container image (#4429).

WHY THIS EXISTS
---------------
Four CSA Loom images pin base images whose netty modules sit at MIXED 4.1.x
versions. Replacing the one module a CVE names (`io.netty:netty-handler`) can
break the classpath in a way no file-listing assertion and no `Class.forName`
smoke test catches: a class in the NEW jar referencing a member that an OLDER
sibling module does not carry. HotSpot resolves member references lazily, so the
failure surfaces at request time in production, not at build time.

That is not hypothetical. On `risingwavelabs/risingwave:v2.1.3`, netty-handler
4.1.137's ``LazyX509Certificate$CertFactoryHandle`` references
``io.netty.util.Recycler$EnhancedHandle``, which netty-common **4.1.77** does not
contain. This tool found it; the fix was to lift the whole netty core, and this
tool is what proved the lift clean.

WHAT IT DOES
------------
Parses JVM class files directly -- no JDK, no ASM, no network -- and resolves
every ``io/netty/**`` class, field and method reference against a given jar set,
walking superclasses and interfaces the way the JVM does.

EVERY MODE RUNS AGAINST A CONTROL. A netty-handler jar ALWAYS names classes a
given image cannot load and never could: the optional native OpenSSL provider
(``io.netty.internal.tcnative``), the optional Conscrypt engine, the
``netty-pkitesting`` test helper. The raw unresolved set is therefore meaningless
as a verdict -- what matters is whether the swap made it WORSE. So the answer is
always a difference, never an absolute, and an allowlist of package names is
deliberately NOT used (it would only move the lie).

USAGE
-----
Extract the jars from the pinned image first, e.g.::

    docker create --name x trinodb/trino:483
    docker cp x:/usr/lib/trino/plugin/cassandra ./cassandra

Then::

    # Does the NEW jar reference anything the sibling set cannot provide?
    # (--control-subject runs the same probe with the jar being replaced, so the
    #  output is a difference and not a pile of pre-existing noise.)
    python scripts/ci/netty_link_check.py forward \\
        --subject netty-handler-4.1.137.Final.jar \\
        --control-subject ./libs/netty-handler-4.1.77.Final.jar \\
        --siblings ./libs/netty-common-*.jar ./libs/netty-buffer-*.jar

    # Did the new jar REMOVE anything the old one exported?
    python scripts/ci/netty_link_check.py backward \\
        --old ./libs/netty-handler-4.1.77.Final.jar \\
        --new netty-handler-4.1.137.Final.jar

    # Do the jars that CALL netty still link against the new one?
    python scripts/ci/netty_link_check.py callers \\
        --subject netty-handler-4.1.137.Final.jar --callers ./libs/*.jar

    # Whole-directory swap: replace N jars, re-check EVERY jar in the directory
    # against both the old and the new set, and report only regressions.
    python scripts/ci/netty_link_check.py swap --dir ./libs \\
        --replace netty-common-4.1.77.Final.jar=./new/netty-common-4.1.137.Final.jar \\
        --replace netty-handler-4.1.77.Final.jar=./new/netty-handler-4.1.137.Final.jar

Exit code is 0 when the swap introduces no new unresolved reference, 1 otherwise.
"""

from __future__ import annotations

import argparse
import glob
import os
import struct
import sys
import zipfile

# Constant-pool tag -> payload size in bytes. Tag 1 (Utf8) is variable and tag 15
# (MethodHandle) is u1+u2; both are handled explicitly below.
CP_SIZES = {
    3: 4, 4: 4, 5: 8, 6: 8, 7: 2, 8: 2, 9: 4, 10: 4, 11: 4,
    12: 4, 15: 3, 16: 2, 17: 4, 18: 4, 19: 2, 20: 2,
}
REF_TAGS = (9, 10, 11)  # Fieldref, Methodref, InterfaceMethodref
ACC_PUBLIC = 0x0001
ACC_PROTECTED = 0x0004


def _parse_constant_pool(b: bytes) -> tuple[list, int]:
    count = struct.unpack_from(">H", b, 8)[0]
    off = 10
    cp: list = [None] * count
    i = 1
    while i < count:
        tag = b[off]
        off += 1
        if tag == 1:
            length = struct.unpack_from(">H", b, off)[0]
            off += 2
            cp[i] = ("Utf8", b[off:off + length].decode("utf-8", "replace"))
            off += length
        else:
            size = CP_SIZES[tag]
            fmt = ">BH" if tag == 15 else ">" + "H" * (size // 2)
            cp[i] = (tag, *struct.unpack_from(fmt, b, off))
            off += size
        i += 2 if tag in (5, 6) else 1
    return cp, off


def _utf(cp: list, idx: int) -> str | None:
    e = cp[idx]
    return e[1] if e and e[0] == "Utf8" else None


def _class_name(cp: list, idx: int) -> str | None:
    e = cp[idx]
    return _utf(cp, e[1]) if e and e[0] == 7 else None


def _skip_attributes(b: bytes, off: int) -> int:
    n = struct.unpack_from(">H", b, off)[0]
    off += 2
    for _ in range(n):
        length = struct.unpack_from(">I", b, off + 2)[0]
        off += 6 + length
    return off


class ClassFile:
    """The slice of a JVM class file this tool needs: identity, supertypes,
    declared members, and every outbound class/member reference."""

    __slots__ = ("class_refs", "interfaces", "members", "name", "refs", "super_name")

    def __init__(self, b: bytes) -> None:
        cp, off = _parse_constant_pool(b)
        _access, this_i, super_i = struct.unpack_from(">HHH", b, off)
        off += 6
        self.name = _class_name(cp, this_i)
        self.super_name = _class_name(cp, super_i) if super_i else None
        n_if = struct.unpack_from(">H", b, off)[0]
        off += 2
        self.interfaces = [
            _class_name(cp, struct.unpack_from(">H", b, off + 2 * k)[0]) for k in range(n_if)
        ]
        off += 2 * n_if

        self.members: set[tuple[str | None, str | None, int]] = set()
        for _ in range(2):  # fields, then methods -- same layout
            n = struct.unpack_from(">H", b, off)[0]
            off += 2
            for _ in range(n):
                m_access, n_i, d_i = struct.unpack_from(">HHH", b, off)
                off += 6
                self.members.add((_utf(cp, n_i), _utf(cp, d_i), m_access))
                off = _skip_attributes(b, off)

        self.refs: set[tuple[str, str | None, str | None]] = set()
        self.class_refs: set[str] = set()
        for e in cp:
            if not e:
                continue
            if e[0] == 7:
                cn = _utf(cp, e[1])
                if cn:
                    self.class_refs.add(cn)
            elif e[0] in REF_TAGS:
                owner = _class_name(cp, e[1])
                nat = cp[e[2]]
                if owner and nat and nat[0] == 12:
                    self.refs.add((owner, _utf(cp, nat[1]), _utf(cp, nat[2])))


def load(jars: list[str]) -> dict[str, ClassFile]:
    """Index every class in `jars` by internal name. First jar wins, which is
    the same first-match rule the JVM applies to a classpath."""
    out: dict[str, ClassFile] = {}
    for j in jars:
        with zipfile.ZipFile(j) as z:
            for n in z.namelist():
                if not n.endswith(".class") or n.startswith("META-INF/"):
                    continue
                try:
                    c = ClassFile(z.read(n))
                except Exception as exc:  # a malformed entry must not abort the scan
                    print(f"  parse-skip {os.path.basename(j)}!{n}: {exc}")
                    continue
                if c.name and c.name not in out:
                    out[c.name] = c
    return out


def resolves(index: dict[str, ClassFile], owner: str, name: str | None, desc: str | None) -> bool | None:
    """True = found, False = definitively absent, None = the lookup left the
    analysed jar set (a JDK supertype), so we cannot say."""
    seen: set[str] = set()
    todo = [owner]
    escaped = False
    while todo:
        cn = todo.pop()
        if cn in seen:
            continue
        seen.add(cn)
        c = index.get(cn)
        if c is None:
            escaped = True
            continue
        for mn, md, _a in c.members:
            if mn == name and md == desc:
                return True
        if c.super_name:
            todo.append(c.super_name)
        todo.extend(i for i in c.interfaces if i)
    return None if escaped else False


def _is_netty(cn: str) -> bool:
    return cn.startswith("io/netty/") and not cn.startswith("[")


def unresolved_refs(subject: dict[str, ClassFile], index: dict[str, ClassFile]) -> set[tuple[str, str]]:
    """Every io.netty class/member a subject names that `index` cannot supply."""
    bad: set[tuple[str, str]] = set()
    for c in subject.values():
        for cn in c.class_refs:
            if _is_netty(cn) and cn not in index:
                bad.add(("CLASS", cn))
        for owner, mn, md in c.refs:
            if _is_netty(owner) and resolves(index, owner, mn, md) is False:
                bad.add(("MEMBER", f"{owner}.{mn}{md}"))
    return bad


def _report(label: str, bad: set[tuple[str, str]]) -> None:
    print(f"{label}: {len(bad)} unresolved")
    for kind, what in sorted(bad):
        print(f"    {kind} {what}")


def _verdict(newly: set[tuple[str, str]], fixed: set[tuple[str, str]]) -> int:
    if fixed:
        print(f"\nALSO FIXED by the swap: {len(fixed)} reference(s) that were ALREADY unresolved")
        for kind, what in sorted(fixed):
            print(f"    {kind} {what}")
    if newly:
        print(f"\nRESULT: REGRESSION -- {len(newly)} reference(s) resolved before the swap and do not after")
        for kind, what in sorted(newly):
            print(f"    NEWLY-UNRESOLVED {kind} {what}")
        return 1
    print("\nRESULT: CLEAN -- 0 newly-unresolved references")
    return 0


def cmd_forward(args: argparse.Namespace) -> int:
    siblings = _expand(args.siblings)
    subject = load([args.subject])
    index = dict(load(siblings))
    index.update(subject)
    print(f"subject  : {os.path.basename(args.subject)} ({len(subject)} classes)")
    print(f"siblings : {len(siblings)} jar(s), {len(index) - len(subject)} classes")
    treatment = unresolved_refs(subject, index)
    _report("TREATMENT", treatment)
    if not args.control_subject:
        print("\nNOTE: no --control-subject given, so this is an ABSOLUTE count, not a verdict.")
        return 0
    ctl_subject = load([args.control_subject])
    ctl_index = dict(load(siblings))
    ctl_index.update(ctl_subject)
    control = unresolved_refs(ctl_subject, ctl_index)
    _report(f"CONTROL ({os.path.basename(args.control_subject)})", control)
    return _verdict(treatment - control, control - treatment)


def cmd_backward(args: argparse.Namespace) -> int:
    old, new = load([args.old]), load([args.new])
    print(f"old {os.path.basename(args.old)}: {len(old)} classes -> "
          f"new {os.path.basename(args.new)}: {len(new)} classes")
    dropped_classes = sorted(set(old) - set(new))
    dropped_members: list[str] = []
    for cn, c in old.items():
        n = new.get(cn)
        if n is None:
            continue
        newset = {(a, b) for a, b, _f in n.members}
        for mn, md, acc in c.members:
            if acc & (ACC_PUBLIC | ACC_PROTECTED) and (mn, md) not in newset:
                dropped_members.append(f"{cn}.{mn}{md}")
    print(f"REMOVED CLASSES: {len(dropped_classes)}")
    for x in dropped_classes:
        print(f"    {x}")
    print(f"REMOVED public/protected MEMBERS: {len(dropped_members)}")
    for x in sorted(dropped_members):
        print(f"    {x}")
    total = len(dropped_classes) + len(dropped_members)
    if total:
        print("\nRESULT: REMOVALS PRESENT -- check each owner's ACCESS FLAGS. A package-private")
        print("        owner cannot be named from another package, so its removal cannot break")
        print("        a caller; a PUBLIC one can, and needs the `callers` mode to clear it.")
        return 1
    print("\nRESULT: NO REMOVALS")
    return 0


def cmd_callers(args: argparse.Namespace) -> int:
    subject = load([args.subject])
    callers = _expand(args.callers)
    cidx = load(callers)
    print(f"subject {os.path.basename(args.subject)}: {len(subject)} classes")
    print(f"callers: {len(callers)} jar(s), {len(cidx)} classes")
    broken = set()
    for c in cidx.values():
        for owner, mn, md in c.refs:
            if owner in subject and resolves(subject, owner, mn, md) is False:
                broken.add((c.name, owner, mn, md))
    print(f"CALLER REFERENCES THAT NO LONGER RESOLVE: {len(broken)}")
    for caller, owner, mn, md in sorted(broken):
        print(f"    {caller} -> {owner}.{mn}{md}")
    if broken:
        print("\nRESULT: BROKEN CALLERS")
        return 1
    print("\nRESULT: CALLERS INTACT")
    return 0


def cmd_swap(args: argparse.Namespace) -> int:
    replacements = dict(r.split("=", 1) for r in args.replace)
    all_jars = sorted(glob.glob(os.path.join(args.dir, "*.jar")))
    netty = [p for p in all_jars if os.path.basename(p).startswith("netty-")
             or "_netty-" in os.path.basename(p)]
    old_set = list(netty)
    new_set = [replacements.get(os.path.basename(p), p) for p in netty]
    lifted = sum(1 for a, b in zip(old_set, new_set, strict=True) if a != b)
    if lifted != len(replacements):
        print(f"ERROR: {len(replacements)} --replace given but only {lifted} matched a jar in {args.dir}")
        return 2
    print(f"netty jars in {args.dir}: {len(old_set)}; replaced: {lifted}")
    old_idx, new_idx = load(old_set), load(new_set)
    print(f"classes: control {len(old_idx)}, treatment {len(new_idx)}\n")

    regressions = 0
    for jar_new in new_set:
        subj = load([jar_new])
        b_ctl = unresolved_refs(subj, old_idx)
        b_new = unresolved_refs(subj, new_idx)
        newly = b_new - b_ctl
        flag = "REGRESSION" if newly else ("ok (+fixed)" if b_ctl - b_new else "ok")
        print(f"  {flag:<12} {os.path.basename(jar_new):<58} control={len(b_ctl):<3} treatment={len(b_new)}")
        for kind, what in sorted(newly):
            print(f"       NEWLY-UNRESOLVED {kind} {what}")
            regressions += 1

    others = [p for p in all_jars if p not in netty]
    print(f"\nnon-netty jars on the same classpath: {len(others)}")
    oth = load(others)
    print(f"non-netty classes: {len(oth)}")
    ctl_bad = unresolved_refs(oth, {**old_idx, **oth})
    new_bad = unresolved_refs(oth, {**new_idx, **oth})
    print(f"  control unresolved io.netty refs from non-netty jars  : {len(ctl_bad)}")
    print(f"  treatment unresolved io.netty refs from non-netty jars: {len(new_bad)}")
    for kind, what in sorted(new_bad - ctl_bad):
        print(f"    NEWLY-UNRESOLVED {kind} {what}")
        regressions += 1

    if regressions:
        print(f"\nRESULT: REGRESSION -- {regressions} newly-unresolved reference(s)")
        return 1
    print("\nRESULT: CLEAN -- 0 newly-unresolved references anywhere in the directory")
    return 0


def _expand(patterns: list[str]) -> list[str]:
    out: list[str] = []
    for p in patterns:
        hits = sorted(glob.glob(p)) if any(ch in p for ch in "*?[") else [p]
        out.extend(hits)
    return out


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="mode", required=True)

    f = sub.add_parser("forward", help="does the NEW jar reference anything the siblings lack?")
    f.add_argument("--subject", required=True)
    f.add_argument("--control-subject", help="the jar being replaced; makes the output a verdict")
    f.add_argument("--siblings", nargs="+", required=True)
    f.set_defaults(fn=cmd_forward)

    b = sub.add_parser("backward", help="did the NEW jar remove anything the OLD one exported?")
    b.add_argument("--old", required=True)
    b.add_argument("--new", required=True)
    b.set_defaults(fn=cmd_backward)

    c = sub.add_parser("callers", help="do the jars that CALL the subject still link against it?")
    c.add_argument("--subject", required=True)
    c.add_argument("--callers", nargs="+", required=True)
    c.set_defaults(fn=cmd_callers)

    s = sub.add_parser("swap", help="whole-directory swap: every jar re-checked against both sets")
    s.add_argument("--dir", required=True)
    s.add_argument("--replace", action="append", required=True, metavar="OLDNAME=NEWPATH")
    s.set_defaults(fn=cmd_swap)

    args = ap.parse_args(argv)
    return args.fn(args)


if __name__ == "__main__":
    sys.exit(main())
