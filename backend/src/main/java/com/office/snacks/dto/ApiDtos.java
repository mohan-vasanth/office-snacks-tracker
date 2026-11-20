package com.office.snacks.dto;

import com.office.snacks.entity.BreakType;
import jakarta.validation.constraints.*;
import jakarta.validation.Valid;
import java.time.Instant;
import java.math.BigDecimal;
import java.util.List;

public final class ApiDtos {
    private ApiDtos() {}
    public record EntityRequest(@NotBlank @Size(max=120) String name, boolean active, @DecimalMin("0.00") BigDecimal unitPrice) {
        public EntityRequest(String name, boolean active) { this(name, active, null); }
    }
    public record EntityResponse(Long id, String name, boolean active, Instant createdAt, BigDecimal unitPrice) {}
    public record RecordRequest(@NotNull Long employeeId, @NotNull Long snackId, @Min(1) int quantity, BreakType breakType, boolean unassigned) {
        public RecordRequest(Long employeeId, Long snackId, int quantity) { this(employeeId, snackId, quantity, null, false); }
        public RecordRequest(Long employeeId, Long snackId, int quantity, BreakType breakType) { this(employeeId, snackId, quantity, breakType, false); }
    }
    public record SnackQuantity(@NotNull Long snackId, @Min(1) int quantity) {}
    public record BatchRecordRequest(@NotNull Long employeeId, @NotEmpty List<@Valid SnackQuantity> items, BreakType breakType) {
        public BatchRecordRequest(Long employeeId, List<SnackQuantity> items) { this(employeeId, items, null); }
    }
    public record RecordResponse(Long id, Long employeeId, String employeeName, Long snackId, String snackName, int quantity, Instant takenAt, BreakType breakType, BigDecimal unitPrice, BigDecimal amount) {}
    public record BreakSummary(long snackCount, long totalQuantity, long recordCount, BigDecimal totalAmount, long unpricedRecords) {}
    public record DashboardResponse(long employeeCount, long activeEmployeeCount, long activeSnackCount, long todayRecordCount, long todayQuantity, BreakSummary morning, BreakSummary evening, BreakSummary combined) {}
    public record DeleteResponse(boolean deleted, String message) {}
}
