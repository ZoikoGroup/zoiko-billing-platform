"""
core/db_types.py
-----------------
Generic SQLAlchemy column-type helpers shared across modules.

CaseInsensitiveEnum was originally defined in the old platform's
employee/models.py, but it's a plain TypeDecorator utility with no
dependency on the employee/HR domain — billing/models.py is its only user
here, so it lives in core/ rather than any domain module.
"""

from sqlalchemy.types import TypeDecorator, VARCHAR


class CaseInsensitiveEnum(TypeDecorator):
    impl = VARCHAR
    cache_ok = True

    def __init__(self, enum_class, *args, **kwargs):
        self.enum_class = enum_class
        self._value_to_enum = {e.value.lower(): e for e in enum_class}
        self._name_to_enum = {e.name.upper(): e for e in enum_class}
        super().__init__(*args, **kwargs)

    def process_bind_param(self, value, dialect):
        if value is None:
            return None
        if isinstance(value, self.enum_class):
            return value.name
        if isinstance(value, str):
            try:
                return self.enum_class(value).name
            except ValueError:
                pass
            try:
                return self.enum_class[value.upper()].name
            except KeyError:
                pass
        raise ValueError(f"Invalid value for {self.enum_class.__name__}: {value}")

    def process_result_value(self, value, dialect):
        if value is None:
            return None
        if isinstance(value, self.enum_class):
            return value
        val_lower = value.lower()
        if val_lower in self._value_to_enum:
            return self._value_to_enum[val_lower]
        val_upper = value.upper()
        if val_upper in self._name_to_enum:
            return self._name_to_enum[val_upper]
        try:
            return self.enum_class(value)
        except ValueError:
            raise ValueError(f"Invalid enum value for {self.enum_class.__name__}: {value}")
