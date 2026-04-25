from __future__ import annotations

from abc import ABC
from dataclasses import dataclass


class ProviderError(RuntimeError):
    pass


class ProviderParseError(ProviderError):
    pass


@dataclass(frozen=True)
class ProviderMetadata:
    provider_id: str
    display_name: str
    capabilities: tuple[str, ...]


class SignalProvider(ABC):
    provider_id: str
    display_name: str
    capabilities: tuple[str, ...] = ()

    def describe(self) -> ProviderMetadata:
        return ProviderMetadata(
            provider_id=self.provider_id,
            display_name=self.display_name,
            capabilities=self.capabilities,
        )
