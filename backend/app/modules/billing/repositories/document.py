from typing import Any, Dict, List, Optional

from app.modules.billing.models import CustomerDocument
from app.modules.billing.repositories.base import BaseRepository


class CustomerDocumentRepository(BaseRepository[CustomerDocument]):
    def __init__(self, db):
        super().__init__(db, CustomerDocument)

    def list_by_customer(
        self, organization_id: int, customer_id: int, active_only: bool = True,
    ) -> List[CustomerDocument]:
        return self.list_all(organization_id, customer_id=customer_id, active_only=active_only)

    def get_by_customer(self, doc_id: int, customer_id: int, organization_id: int) -> CustomerDocument:
        return self.get_by_id(doc_id, organization_id)
