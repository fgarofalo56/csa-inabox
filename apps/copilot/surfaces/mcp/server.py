"""CopilotMCPServer — MCP stdio (and optional HTTP) transport.

Wires the Copilot agent, tool registry, and resource bridges into an
MCP server.  Every handler is async; all resources / tools are
registered lazily so the server object can be constructed for tests
without loading the ``mcp`` SDK's transport layer.

Usage::

    server = CopilotMCPServer.from_defaults()
    await server.run_stdio()                     # blocks until stdin closes
"""

from __future__ import annotations

import importlib.util
import json
from contextlib import AsyncExitStack
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Any

from apps.copilot.surfaces.mcp.resource_bridge import (
    ResourceDescriptor,
    parse_corpus_uri,
    parse_decision_tree_uri,
    parse_repo_file_uri,
    read_corpus_resource,
    read_decision_tree_resource,
    read_repo_file_resource,
    static_resource_descriptors,
)
from apps.copilot.surfaces.mcp.tool_bridge import (
    MCPToolSpec,
    advertise_tools,
    invoke_tool,
    render_tool_result_text,
)
from apps.copilot.tools.registry import ToolRegistry
from csa_platform.common.logging import get_logger

if TYPE_CHECKING:  # pragma: no cover
    from apps.copilot.agent import CopilotAgent
    from apps.copilot.tools.readonly import (
        ReadRepoFileTool,
        SearchCorpusTool,
        WalkDecisionTreeTool,
    )

logger = get_logger(__name__)


@dataclass
class CopilotMCPServer:
    """Owns the Copilot dependencies and exposes them to the MCP SDK.

    Construction is decoupled from SDK registration so tests can drive
    the pure-Python dispatch logic (``handle_list_tools``,
    ``handle_call_tool``, ``handle_read_resource``) without importing
    the ``mcp`` transport layer.
    """

    agent: CopilotAgent
    registry: ToolRegistry
    search_tool: SearchCorpusTool
    walker: WalkDecisionTreeTool
    file_reader: ReadRepoFileTool
    repo_root: Path

    @classmethod
    def from_defaults(
        cls,
        *,
        repo_root: Path | None = None,
    ) -> CopilotMCPServer:
        """Build a server using the default dependency factories.

        The factory performs imports lazily so environments missing
        Azure credentials can still import this module and stub in
        their own registry / agent through the dataclass fields.
        """
        from apps.copilot.agent import CopilotAgent
        from apps.copilot.config import CopilotSettings
        from apps.copilot.tools.readonly import (
            ReadRepoFileTool,
            SearchCorpusTool,
            WalkDecisionTreeTool,
        )

        repo = (repo_root or Path(__file__).resolve().parents[4]).resolve()
        settings = CopilotSettings()
        agent = CopilotAgent.from_settings(settings)
        search = SearchCorpusTool(retriever=agent.retriever, embedder=agent.embedder)
        walker = WalkDecisionTreeTool(trees_root=repo / "decision-trees")
        reader = ReadRepoFileTool(repo_root=repo)

        registry = ToolRegistry([search, walker, reader])
        return cls(
            agent=agent,
            registry=registry,
            search_tool=search,
            walker=walker,
            file_reader=reader,
            repo_root=repo,
        )

    # ─── Pure-Python dispatch (exercised by unit tests) ─────────────────

    def list_tool_specs(self) -> list[MCPToolSpec]:
        """Advertise every registered tool plus the ``ask`` and ``list_skills`` tools."""
        specs = list(advertise_tools(self.registry))
        specs.append(
            MCPToolSpec(
                name="ask",
                description=(
                    "Answer a question using the Copilot's grounded Q&A "
                    "pipeline.  Returns the verified answer + citations."
                ),
                input_schema={
                    "type": "object",
                    "properties": {
                        "question": {"type": "string", "minLength": 1},
                    },
                    "required": ["question"],
                },
            ),
        )
        specs.append(
            MCPToolSpec(
                name="list_skills",
                description=(
                    "Return the registered Copilot skills (empty when "
                    "the skills package is not installed)."
                ),
                input_schema={"type": "object", "properties": {}},
            ),
        )
        specs.append(
            MCPToolSpec(
                name="run_skill",
                description=(
                    "Invoke a registered skill by name (requires the "
                    "apps.copilot.skills package to be installed)."
                ),
                input_schema={
                    "type": "object",
                    "properties": {
                        "skill_name": {"type": "string", "minLength": 1},
                        "arguments": {"type": "object"},
                    },
                    "required": ["skill_name"],
                },
            ),
        )
        return specs

    def list_resource_descriptors(self) -> list[ResourceDescriptor]:
        """Return static resource descriptors for advertisement."""
        return static_resource_descriptors()

    async def handle_call_tool(
        self,
        name: str,
        arguments: dict[str, Any],
    ) -> str:
        """Dispatch an MCP ``call_tool`` request to the right handler.

        Returns a JSON-serialised string payload (the MCP server wraps
        it in ``TextContent``).
        """
        logger.info(
            "copilot.mcp.call_tool",
            surface="mcp",
            method="call_tool",
            tool=name,
        )
        if name == "ask":
            question = str(arguments.get("question", "")).strip()
            if not question:
                return json.dumps(
                    {"status": "invalid_arguments", "error": "question is required"},
                )
            response = await self.agent.ask(question)
            return json.dumps(
                {"status": "ok", "output": response.model_dump(mode="json")},
                indent=2,
                sort_keys=True,
            )
        if name == "list_skills":
            return json.dumps({"status": "ok", "skills": self._list_skills()})
        if name == "run_skill":
            return json.dumps(self._run_skill(arguments))

        result = await invoke_tool(self.registry, name, arguments)
        return render_tool_result_text(result)

    async def handle_read_resource(self, uri: str) -> str:
        """Dispatch an MCP ``read_resource`` request."""
        logger.info(
            "copilot.mcp.read_resource",
            surface="mcp",
            method="read_resource",
            uri=uri,
        )
        query = parse_corpus_uri(uri)
        if query is not None:
            data = await read_corpus_resource(self.search_tool, query)
            return json.dumps(data, indent=2, sort_keys=True, default=str)

        tree_id = parse_decision_tree_uri(uri)
        if tree_id is not None:
            data = await read_decision_tree_resource(self.walker, tree_id)
            return json.dumps(data, indent=2, sort_keys=True, default=str)

        repo_path = parse_repo_file_uri(uri)
        if repo_path is not None:
            data = await read_repo_file_resource(self.file_reader, repo_path)
            return json.dumps(data, indent=2, sort_keys=True, default=str)

        return json.dumps({"status": "unknown_resource", "uri": uri})

    # ─── Skills bridge ──────────────────────────────────────────────────

    @staticmethod
    def _list_skills() -> list[dict[str, Any]]:
        spec = importlib.util.find_spec("apps.copilot.skills")
        if spec is None:
            return []
        try:
            from apps.copilot.skills.catalog import SkillCatalog

            catalog = SkillCatalog.from_shipped()
            return [
                {
                    "id": skill.id,
                    "name": getattr(skill, "name", skill.id),
                    "description": getattr(skill, "description", ""),
                }
                for skill in catalog.list()
            ]
        except Exception as exc:  # pragma: no cover - feature flag
            logger.warning("copilot.mcp.list_skills_error", error=str(exc))
            return []

    def _run_skill(self, arguments: dict[str, Any]) -> dict[str, Any]:
        # Skills that call execute-class tools require a broker + approval
        # callback.  The MCP surface cannot run interactive approvals, so
        # we return a structured refusal telling the client to drive the
        # skill via the FastAPI surface instead.
        spec = importlib.util.find_spec("apps.copilot.skills")
        if spec is None:
            return {"status": "unavailable", "error": "skills package not installed"}
        return {
            "status": "refused_interactive",
            "message": (
                "Skill execution requires a broker + approval callback; "
                "use the FastAPI surface or the Python SkillCatalog API "
                "directly.  MCP cannot gate interactive approvals."
            ),
            "echo": arguments,
        }

    # ─── SDK integration ────────────────────────────────────────────────

    # ─── MCP SDK server wiring ──────────────────────────────────────────

    def _build_lowlevel_server(self) -> Any:
        """Construct an ``mcp.server.Server`` bound to our dispatch methods.

        The server is used by both the stdio and the streamable HTTP
        transports — keep the SDK-specific registration in one place.
        """
        import mcp.types as mcp_types
        from mcp.server import Server

        server: Server = Server("csa-copilot")

        @server.list_tools()  # type: ignore[no-untyped-call,misc]
        async def _list_tools() -> list[mcp_types.Tool]:
            return [
                mcp_types.Tool(
                    name=spec.name,
                    description=spec.description,
                    inputSchema=spec.input_schema,
                )
                for spec in self.list_tool_specs()
            ]

        @server.list_resources()  # type: ignore[no-untyped-call,misc]
        async def _list_resources() -> list[mcp_types.Resource]:
            return [
                mcp_types.Resource(
                    uri=desc.uri,  # type: ignore[arg-type]
                    name=desc.name,
                    description=desc.description,
                    mimeType=desc.mime_type,
                )
                for desc in self.list_resource_descriptors()
            ]

        @server.call_tool()  # type: ignore[misc]
        async def _call_tool(
            name: str,
            arguments: dict[str, Any] | None,
        ) -> list[mcp_types.TextContent]:
            text = await self.handle_call_tool(name, arguments or {})
            return [mcp_types.TextContent(type="text", text=text)]

        @server.read_resource()  # type: ignore[no-untyped-call,misc]
        async def _read_resource(uri: Any) -> str:
            return await self.handle_read_resource(str(uri))

        return server

    async def run_stdio(self) -> None:
        """Attach the dispatcher to the MCP SDK's stdio transport."""
        from mcp.server.stdio import stdio_server

        server = self._build_lowlevel_server()

        async with AsyncExitStack() as stack:
            streams = await stack.enter_async_context(stdio_server())
            read_stream, write_stream = streams
            await server.run(
                read_stream,
                write_stream,
                server.create_initialization_options(),
            )

    def build_http_app(
        self,
        *,
        stateless: bool = True,
        json_response: bool = False,
        mount_path: str = "/mcp",
    ) -> Any:
        """Build a Starlette ASGI application hosting the MCP streamable HTTP transport.

        Args:
            stateless: When True (default) each request is handled with
                a fresh transport — matches the ``--session-mode``
                default on the CLI.  False enables stateful session
                tracking via the ``Mcp-Session-Id`` header.
            json_response: When True, responses are emitted as plain
                JSON instead of SSE event streams. Useful for test
                clients that don't speak SSE.
            mount_path: URL path the MCP endpoint is mounted under
                (default ``/mcp``).

        Returns:
            A :class:`starlette.applications.Starlette` app that can be
            served with ``uvicorn.run`` or driven in-process by
            ``httpx.AsyncClient`` / :class:`starlette.testclient.TestClient`.
        """
        from contextlib import asynccontextmanager

        from mcp.server.streamable_http_manager import (
            StreamableHTTPSessionManager,
        )
        from starlette.applications import Starlette
        from starlette.routing import Mount
        from starlette.types import Receive, Scope, Send

        low_level = self._build_lowlevel_server()
        session_manager = StreamableHTTPSessionManager(
            app=low_level,
            event_store=None,
            json_response=json_response,
            stateless=stateless,
        )

        async def _handle_streamable(
            scope: Scope,
            receive: Receive,
            send: Send,
        ) -> None:
            await session_manager.handle_request(scope, receive, send)

        @asynccontextmanager
        async def _lifespan(_app: Starlette) -> Any:
            async with session_manager.run():
                logger.info(
                    "copilot.mcp.http_lifespan_started",
                    surface="mcp",
                    transport="http",
                    stateless=stateless,
                )
                try:
                    yield
                finally:
                    logger.info(
                        "copilot.mcp.http_lifespan_stopped",
                        surface="mcp",
                        transport="http",
                    )

        starlette_app = Starlette(
            debug=False,
            routes=[Mount(mount_path, app=_handle_streamable)],
            lifespan=_lifespan,
        )
        starlette_app.state.mcp_session_manager = session_manager
        starlette_app.state.mcp_mount_path = mount_path
        return starlette_app

    async def run_http(
        self,
        *,
        host: str,
        port: int,
        stateless: bool = True,
        json_response: bool = False,
        mount_path: str = "/mcp",
    ) -> None:
        """Serve the streamable HTTP transport via uvicorn.

        Blocks until the server is interrupted.  Tests should use
        :meth:`build_http_app` + a TestClient / ASGI harness instead.
        """
        import uvicorn

        app = self.build_http_app(
            stateless=stateless,
            json_response=json_response,
            mount_path=mount_path,
        )
        config = uvicorn.Config(
            app,
            host=host,
            port=port,
            log_level="info",
        )
        logger.info(
            "copilot.mcp.http_starting",
            surface="mcp",
            transport="http",
            host=host,
            port=port,
            stateless=stateless,
            mount_path=mount_path,
        )
        await uvicorn.Server(config).serve()


__all__ = ["CopilotMCPServer"]
