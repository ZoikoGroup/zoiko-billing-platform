from fastapi import APIRouter, Depends, Request
from sqlalchemy.orm import Session

from app.core.dependencies import get_current_user, require_active_subscription
from app.database import get_db

from .schemas import ChatbotMessageRequest, ChatbotResponse
from .service import ChatbotService

router = APIRouter(
    prefix="/chatbot",
    tags=["Zoiko Billing Chatbot"],
    dependencies=[Depends(require_active_subscription("billing"))],
)


@router.post("/message", response_model=ChatbotResponse)
def create_chatbot_message(
    body: ChatbotMessageRequest,
    request: Request,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    return ChatbotService(db).respond(
        message=body.message,
        conversation_id=body.conversation_id,
        current_user=current_user,
        request_id=getattr(request.state, "request_id", None),
    )
