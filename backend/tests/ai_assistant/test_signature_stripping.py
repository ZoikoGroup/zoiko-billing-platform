"""Tests for the defensive assistant-signature footer strip.

Guards against the LLM appending unwanted branding/sign-off lines (e.g.
"-- Zoiko Billing Assistant", "Sincerely, Zoiko Billing Assistant") below
its saved answer, so the visible reply ends on the real answer content.

The strip is deliberately conservative: only trailing lines anchored on the
assistant identity ("Zoiko ... Billing Assistant") — plus an optional bare
sign-off line directly above it — are removed. Generic conversational text
that could be legitimate answer content is left untouched.
"""

from app.modules.chatbot.conversation.engine import ConversationEngine


def _strip(text):
    return ConversationEngine._strip_assistant_signature(object(), text)


def test_strips_em_dash_signature():
    assert _strip("Revenue Report shows monthly totals.\n\n— Zoiko Billing Assistant") == \
        "Revenue Report shows monthly totals."


def test_strips_hyphen_signature():
    assert _strip("Answer line.\n- Zoiko Billing Assistant") == "Answer line."


def test_strips_sincerely_signature():
    assert _strip("Here is the summary.\n\nSincerely,\nZoiko Billing Assistant") == \
        "Here is the summary."


def test_strips_pure_identity_footer():
    assert _strip("Outstanding balance is $100.\n\nZoiko Billing Assistant") == \
        "Outstanding balance is $100."


def test_strips_signoff_above_identity():
    assert _strip("Summary.\n\nRegards,\nZoiko Billing Assistant") == "Summary."


def test_leaves_middle_content_untouched():
    text = "The Zoiko Billing Assistant helps users.\nNothing to strip."
    assert _strip(text) == text


def test_strips_multiple_trailing_identity_lines():
    assert _strip("Answer.\n\nZoiko Billing Assistant\nZoiko Billing Assistant") == "Answer."


def test_handles_blank_answer():
    assert _strip(None) is None


def test_does_not_strip_legitimate_body_text():
    text = "The collection rate is 85%.\nLet me know if you need the breakdown."
    assert _strip(text) == text


def test_does_not_strip_mid_answer_zoiko_reference():
    text = "Per the Zoiko Billing Assistant, refunds process in 5 days."
    assert _strip(text) == text
