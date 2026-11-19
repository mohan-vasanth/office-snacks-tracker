package com.office.snacks.dto;

import jakarta.validation.constraints.*;
import jakarta.validation.Valid;
import java.time.Instant;
import java.util.List;

public final class ApiDtos {
    private ApiDtos() {}
    public record EntityRequest(@NotBlank @Size(max=120) String name, boolean active) {}
    public record EntityResponse(Long id, String name, boolean active, Instant createdAt) {}
    public record RecordRequest(@NotNull Long employeeId, @NotNull Long snackId, @Min(1) int quantity) {}
    public record SnackQuantity(@NotNull Long snackId, @Min(1) int quantity) {}
    public record BatchRecordRequest(@NotNull Long employeeId, @NotEmpty List<@Valid SnackQuantity> items) {}
    public record RecordResponse(Long id, Long employeeId, String employeeName, Long snackId, String snackName, int quantity, Instant takenAt) {}
    public record DashboardResponse(long employeeCount, long activeEmployeeCount, long activeSnackCount, long todayRecordCount, long todayQuantity) {}
    public record DeleteResponse(boolean deleted, String message) {}
}
