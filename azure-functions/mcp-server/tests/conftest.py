"""Put the function app dir on sys.path so `import function_app` / `import mcp_tools`
work the same way the Azure Functions host loads them."""
import os
import sys

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
