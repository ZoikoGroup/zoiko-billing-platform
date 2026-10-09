"""B14: the Edit Organization form can only show (and avoid blanking) fields
that GET /organizations/me/detail returns. Tax ID and registration number
were accepted by PUT /organizations/me but never returned."""
from types import SimpleNamespace

from app.modules.organizations.router import get_my_organization_detail, update_my_organization
from app.modules.organizations.schemas import OrganizationUpdate
from tests.conftest import make_organization


def test_detail_returns_every_editable_field(db_session):
    org = make_organization(db_session, code="B14", name="B14 Org")
    org.tax_no = "27AAAPL1234C1ZV"
    org.registration_number = "U72200MH2020PTC123456"
    org.legal_name = "B14 Holdings"
    db_session.commit()
    user = SimpleNamespace(organization_id=org.id, role="org_admin")
    detail = get_my_organization_detail(current_user=user, db=db_session)
    assert detail.tax_no == "27AAAPL1234C1ZV"
    assert detail.registration_number == "U72200MH2020PTC123456"
    assert detail.legal_name == "B14 Holdings"


def test_partial_update_leaves_untouched_fields(db_session):
    org = make_organization(db_session, code="B14P", name="Keep Me")
    org.tax_no = "TAX-1"
    db_session.commit()
    user = SimpleNamespace(organization_id=org.id, role="org_admin")
    update_my_organization(data=OrganizationUpdate(phone="+91 11 2222 3333"), current_user=user, db=db_session)
    db_session.refresh(org)
    assert org.phone == "+91 11 2222 3333"
    assert org.organization_name == "Keep Me" and org.tax_no == "TAX-1"
