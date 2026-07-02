import datetime
import fabric.functions as fn
import logging

udf = fn.UserDataFunctions()


@udf.function()
def compute_score(user_id: str, weight: float = 1.0) -> dict:
    """Day-one sample UDF. Matches the editor's default source so a fresh bicep
    deploy answers the default Test/Run panel with a real, computed result."""
    logging.info("Python UDF trigger function processed a request.")
    return {
        "user": user_id,
        "score": weight * 42,
        "computed_at": datetime.datetime.utcnow().isoformat() + "Z",
    }


@udf.function()
def echo(message: str = "hello") -> dict:
    """Trivial echo so the host has a second callable to prove routing."""
    return {"echo": message}
