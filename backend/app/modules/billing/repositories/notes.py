from typing import Any, Dict, List, Optional

from app.modules.billing.models import CustomerNote
from app.modules.billing.repositories.base import BaseRepository


class CustomerNoteRepository(BaseRepository[CustomerNote]):
    def __init__(self, db):
        super().__init__(db, CustomerNote)

    def list_by_customer(
        self, organization_id: int, customer_id: int, active_only: bool = True,
    ) -> List[CustomerNote]:
        return self.list_all(organization_id, customer_id=customer_id, active_only=active_only)

    def get_by_customer(self, note_id: int, customer_id: int, organization_id: int) -> CustomerNote:
        return self.get_by_id(note_id, organization_id)
