package com.office.snacks.repository;
import com.office.snacks.entity.SnackRecord;
import org.springframework.data.jpa.repository.*;
import org.springframework.data.repository.query.Param;
import java.time.Instant;
import java.util.*;
public interface SnackRecordRepository extends JpaRepository<SnackRecord,Long> {
 @Query("select r from SnackRecord r join fetch r.employee join fetch r.snack where r.id = :id") Optional<SnackRecord> findDetailedById(@Param("id") Long id);
 boolean existsByEmployee_Id(Long employeeId);
 boolean existsBySnack_Id(Long snackId);
 @Query("select r from SnackRecord r join fetch r.employee join fetch r.snack where (:fromTime is null or r.takenAt >= :fromTime) and (:toTime is null or r.takenAt < :toTime) and (:employeeId is null or r.employee.id = :employeeId) and (:snackId is null or r.snack.id = :snackId) order by r.takenAt desc")
 List<SnackRecord> filtered(@Param("fromTime") Instant from, @Param("toTime") Instant to, @Param("employeeId") Long employeeId, @Param("snackId") Long snackId);
 long countByTakenAtGreaterThanEqualAndTakenAtLessThan(Instant from, Instant to);
 @Query("select coalesce(sum(r.quantity),0) from SnackRecord r where r.takenAt >= :fromTime and r.takenAt < :toTime") long quantityBetween(@Param("fromTime") Instant from, @Param("toTime") Instant to);
 @Query("select new com.office.snacks.dto.TotalRow(r.employee.id,r.employee.name,sum(r.quantity),count(r)) from SnackRecord r where r.takenAt >= :fromTime and r.takenAt < :toTime group by r.employee.id,r.employee.name order by sum(r.quantity) desc") List<com.office.snacks.dto.TotalRow> employeeTotals(@Param("fromTime") Instant from,@Param("toTime") Instant to);
 @Query("select new com.office.snacks.dto.TotalRow(r.snack.id,r.snack.name,sum(r.quantity),count(r)) from SnackRecord r where r.takenAt >= :fromTime and r.takenAt < :toTime group by r.snack.id,r.snack.name order by sum(r.quantity) desc") List<com.office.snacks.dto.TotalRow> snackTotals(@Param("fromTime") Instant from,@Param("toTime") Instant to);
}
