"""
Stream cancellation tests (Stop button support).

Covers the two backend pieces of generation cancellation:
  1. Engine: ``_generate_llm_answer_stream`` breaks between deltas as soon as
     ``_stop_event`` is set — the provider is never asked to keep streaming for
     a client that already pressed Stop (no wasted LLM tokens).  The partial
     answer accumulated so far is kept (that is what the client showed).
  2. Router: ``POST /sessions/{uid}/messages/stream/cancel`` sets the stop
     event registered by the active stream, and is a no-op otherwise.
"""
import threading
from types import SimpleNamespace

from app.modules.chatbot import router as chatbot_router
from app.modules.chatbot.conversation.engine import ConversationEngine


def _config():
    return SimpleNamespace(model="test-model", max_tokens=64, temperature=0.0)


def _ctx():
    # tenant_context_id None -> no ModelRun audit row is attempted, keeping the
    # test focused purely on the streaming loop.
    return SimpleNamespace(tenant_context_id=None)


def _fake_streamer(tokens, signal_on_first=False):
    """Deterministic provider streamer.  When `signal_on_first` is set, the
    token sink is expected to set the stop event after the first delta."""
    def streamer(messages=None, system_prompt=None, model=None, max_tokens=None, temperature=None):
        for token in tokens:
            yield token
    return streamer


def test_llm_stream_breaks_mid_answer_when_stop_event_set(db_session):
    """Stop set by the first delta must stop generation after that delta —
    the partial answer is returned and the sink is called exactly once."""
    eng = ConversationEngine(db_session, model_gateway=None)
    stop = threading.Event()
    eng._stop_event = stop
    calls = []
    eng._token_sink = lambda t: (calls.append(t), stop.set())
    out = eng._generate_llm_answer_stream(
        "query", [], "system", _config(), "fake", _ctx(), _fake_streamer(["Hello ", "world"])
    )
    assert out == "Hello"
    assert calls == ["Hello "]


def test_llm_stream_relays_all_deltas_when_no_stop(db_session):
    """Without a stop signal the streamed loop is unchanged — full answer and
    every delta relayed to the sink (regression guard)."""
    eng = ConversationEngine(db_session, model_gateway=None)
    calls = []
    eng._token_sink = lambda t: calls.append(t)
    out = eng._generate_llm_answer_stream(
        "query", [], "system", _config(), "fake", _ctx(), _fake_streamer(["Hello ", "world"])
    )
    assert out == "Hello world"
    assert calls == ["Hello ", "world"]


def test_pre_set_stop_event_stops_before_first_delta(db_session):
    """If Stop is pressed before any token is generated the loop breaks at the
    first check -> no tokens relayed, and the (empty) stream returns None."""
    eng = ConversationEngine(db_session, model_gateway=None)
    stop = threading.Event()
    stop.set()
    eng._stop_event = stop
    calls = []
    eng._token_sink = lambda t: calls.append(t)
    out = eng._generate_llm_answer_stream(
        "query", [], "system", _config(), "fake", _ctx(), _fake_streamer(["Hello ", "world"])
    )
    assert out is None
    assert calls == []


def test_cancel_endpoint_sets_registered_stop_event():
    """POST /messages/stream/cancel flips the event the active stream registered:
    `{"cancelled": true}` for a live stream, `{"cancelled": false}` for one that
    already finished (or never existed)."""
    event = threading.Event()
    chatbot_router._STREAM_STOPS["conv-stop"] = event
    try:
        assert chatbot_router.cancel_stream("conv-stop", request=None) == {"cancelled": True}
        assert event.is_set()
        assert chatbot_router.cancel_stream("conv-finished", request=None) == {"cancelled": False}
    finally:
        chatbot_router._STREAM_STOPS.pop("conv-stop", None)