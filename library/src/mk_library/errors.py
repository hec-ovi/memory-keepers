CODES = (
    "WORLD_NOT_FOUND", "KEEPER_NOT_FOUND", "KEEPER_EXISTS", "KEEPERS_FULL",
    "BOOK_NOT_FOUND", "LIBRARY_FULL", "DREAM_NOT_FOUND",
)


class LibraryError(Exception):
    def __init__(self, code: str, message: str = ""):
        assert code in CODES
        self.code = code
        super().__init__(message or code)
